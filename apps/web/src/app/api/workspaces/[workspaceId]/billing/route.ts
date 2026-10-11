import { NextResponse } from "next/server";
import { z } from "zod";
import {
  applyVerifiedSubscriptionPayment,
  getWorkspaceForUser,
  getWorkspaceSubscription,
  keepSubscriptionActive,
  listSubscriptionPayments,
  scheduleSubscriptionCancellation
} from "@paylore/database";
import {
  clearSessionCookie,
  getSessionState
} from "../../../../../server/session";
import {
  assertSameOrigin,
  RequestSecurityError
} from "../../../../../server/security";
import { getDatabase } from "../../../../../server/db";
import {
  PaymentVerificationError,
  verifySubscriptionPayment
} from "../../../../../server/solana/payment-verification";

const paymentSchema = z.object({
  signature: z
    .string()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/)
});

const cancellationSchema = z.object({
  action: z.enum(["cancel", "keep-active"])
});

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

async function getAuthorizedWorkspace(
  workspaceId: string
) {
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    await clearSessionCookie();
    return { response: NextResponse.json({ error: "authentication_required" }, { status: 401 }) };
  }

  const db = getDatabase();
  const membership = await getWorkspaceForUser(
    db,
    session.session.userId,
    workspaceId
  );

  if (!membership) {
    return { response: NextResponse.json({ error: "workspace_access_denied" }, { status: 403 }) };
  }

  return {
    db,
    membership,
    session: session.session
  };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: RouteContext
) {
  const { workspaceId } = await params;
  const access = await getAuthorizedWorkspace(workspaceId);
  if ("response" in access) {
    return access.response;
  }

  const [subscription, payments] = await Promise.all([
    getWorkspaceSubscription(access.db, workspaceId),
    listSubscriptionPayments(access.db, workspaceId)
  ]);

  return NextResponse.json({
    subscription,
    payments,
    canManage: access.membership.role === "organization_admin"
  });
}

export async function POST(
  request: Request,
  { params }: RouteContext
) {
  try {
    assertSameOrigin(request);
    const { workspaceId } = await params;
    const access = await getAuthorizedWorkspace(workspaceId);
    if ("response" in access) {
      return access.response;
    }
    if (access.membership.role !== "organization_admin") {
      return NextResponse.json({ error: "workspace_access_denied" }, { status: 403 });
    }

    const parsed = paymentSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_payment_signature" }, { status: 400 });
    }

    const verified = await verifySubscriptionPayment(
      parsed.data.signature,
      access.session.walletAddress
    );
    const result = await applyVerifiedSubscriptionPayment(
      access.db,
      {
        workspaceId,
        userId: access.session.userId,
        ...verified
      }
    );

    return NextResponse.json({
      status: "active",
      duplicate: result.duplicate,
      periodEnd: result.periodEnd
    });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    if (error instanceof PaymentVerificationError) {
      const status = error.reason === "configuration" ? 503 : 422;
      return NextResponse.json(
        { error: "payment_could_not_be_verified" },
        { status }
      );
    }
    console.error(
      JSON.stringify({
        event: "subscription_payment_verification_failed"
      })
    );
    return NextResponse.json(
      { error: "payment_could_not_be_verified" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: RouteContext
) {
  try {
    assertSameOrigin(request);
    const { workspaceId } = await params;
    const access = await getAuthorizedWorkspace(workspaceId);
    if ("response" in access) {
      return access.response;
    }
    if (access.membership.role !== "organization_admin") {
      return NextResponse.json({ error: "workspace_access_denied" }, { status: 403 });
    }

    const parsed = cancellationSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_billing_action" }, { status: 400 });
    }

    const subscription =
      parsed.data.action === "cancel"
        ? await scheduleSubscriptionCancellation(access.db, workspaceId)
        : await keepSubscriptionActive(access.db, workspaceId);

    return NextResponse.json({ subscription });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    console.error(
      JSON.stringify({ event: "subscription_change_failed" })
    );
    return NextResponse.json(
      { error: "subscription_change_failed" },
      { status: 500 }
    );
  }
}
