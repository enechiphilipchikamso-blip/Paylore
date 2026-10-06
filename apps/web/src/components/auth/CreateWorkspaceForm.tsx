"use client";

import {
  useState,
  type FormEvent
} from "react";
import { useRouter } from "next/navigation";

export function CreateWorkspaceForm() {
  const router = useRouter();

  const [name, setName] =
    useState("");

  const [error, setError] =
    useState<string | null>(
      null
    );

  const [submitting, setSubmitting] =
    useState(false);

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    const trimmedName =
      name.trim();

    if (!trimmedName) {
      setError(
        "Enter a workspace name."
      );
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      const response =
        await fetch(
          "/api/workspaces",
          {
            method: "POST",
            headers: {
              "content-type":
                "application/json"
            },
            credentials:
              "same-origin",
            body: JSON.stringify({
              name: trimmedName
            })
          }
        );

      const body =
        (await response.json()) as
          | {
              workspaceId: string;
            }
          | {
              error: string;
            };

      if (
        !response.ok ||
        !("workspaceId" in
          body)
      ) {
        if (
          response.status === 429 &&
          "error" in body
        ) {
          throw new Error(
            "Workspace creation is temporarily limited. Try again shortly."
          );
        }

        throw new Error(
          "Workspace could not be created. Try again."
        );
      }

      router.replace(
        `/workspace/${body.workspaceId}?created=1`
      );

      router.refresh();
    } catch (cause) {
      setSubmitting(false);

      setError(
        cause instanceof Error
          ? cause.message
          : "Workspace could not be created. Try again."
      );
    }
  }

  return (
    <form
      className="auth-form"
      onSubmit={(
        event: FormEvent<HTMLFormElement>
      ) =>
        void handleSubmit(event)
      }
    >
      <div className="field">
        <label htmlFor="workspace-name">
          Workspace name
        </label>

        <input
          id="workspace-name"
          name="workspaceName"
          type="text"
          autoComplete="organization"
          value={name}
          onChange={(event) =>
            setName(
              event.target.value
            )
          }
          maxLength={120}
          required
        />

        <p className="field__helper">
          Workspace names do not need
          to be unique.
        </p>
      </div>

      <button
        className="button"
        type="submit"
        disabled={submitting}
      >
        {submitting
          ? "Creating workspace…"
          : "Create workspace"}
      </button>

      {error ? (
        <div
          className="error-box"
          role="alert"
        >
          {error}
        </div>
      ) : null}
    </form>
  );
}