"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type DeadLetter = {
  id: string;
  transactionSignature: string | null;
  transactionSlot: string | null;
  eventType: string | null;
  status: string;
  attempts: number;
  lastErrorCode: string | null;
  receivedAt: Date | string;
  processedAt: Date | string | null;
};

export function WebhookDeadLetterQueue({
  workspaceId,
  events
}: {
  workspaceId: string;
  events: DeadLetter[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function retry(eventId: string) {
    if (busyId) return;
    setBusyId(eventId);
    setMessage(null);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/webhook-events`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId })
      });
      if (!response.ok) {
        setMessage(response.status === 404
          ? "This event is no longer eligible for retry. Refresh the queue."
          : "Retry could not be scheduled. Refresh and try again.");
        return;
      }
      setMessage("Retry scheduled. The event will be checked against finalized blockchain state again.");
      router.refresh();
    } catch {
      setMessage("Retry could not be scheduled. Check your connection and try again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="surface-card" aria-labelledby="webhook-dead-letter-title">
      <p className="eyebrow">System & Reliability</p>
      <h2 id="webhook-dead-letter-title">Webhook events needing review</h2>
      <p>These events exhausted automatic retries. Receipt alone does not establish a successful transaction. Retrying repeats finalized-chain verification; it does not mark an event successful.</p>
      {message ? <p role="status" aria-live="polite">{message}</p> : null}
      {events.length === 0 ? (
        <p>No workspace-linked webhook events need review.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead><tr><th scope="col">Received</th><th scope="col">Event</th><th scope="col">Transaction</th><th scope="col">Attempts</th><th scope="col">Last issue</th><th scope="col">Action</th></tr></thead>
            <tbody>{events.map((event) => (
              <tr key={event.id}>
                <td>{new Date(event.receivedAt).toLocaleString()}</td>
                <td>{event.eventType ?? "Unclassified transaction"}</td>
                <td>{event.transactionSignature ? <a href={`https://explorer.solana.com/tx/${encodeURIComponent(event.transactionSignature)}?cluster=devnet`} target="_blank" rel="noreferrer">View transaction</a> : "No signature recorded"}</td>
                <td>{event.attempts}</td>
                <td>{event.lastErrorCode ?? "Needs review"}</td>
                <td><button className="button button--secondary" type="button" disabled={busyId !== null || !event.transactionSignature} onClick={() => void retry(event.id)}>{busyId === event.id ? "Scheduling…" : "Retry verification"}</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
