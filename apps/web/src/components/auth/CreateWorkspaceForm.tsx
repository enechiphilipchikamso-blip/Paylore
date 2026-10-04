"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function CreateWorkspaceForm() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [error, setError] = useState<
    string | null
  >(null);
  const [submitting, setSubmitting] =
    useState(false);

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    const trimmedName = name.trim();

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
            credentials: "same-origin",
            body: JSON.stringify({
              name: trimmedName
            })
          }
        );

      const body =
        (await response.json()) as
          | { workspaceId: string }
          | { error: string };

      if (
        !response.ok ||
        !("workspaceId" in body)
      ) {
        throw new Error(
          "Workspace could not be created."
        );
      }

      router.replace(
        `/workspace/${body.workspaceId}`
      );
      router.refresh();
    } catch (cause) {
      setSubmitting(false);

      setError(
        cause instanceof Error
          ? cause.message
          : "Workspace could not be created."
      );
    }
  }

  return (
    <form
      className="auth-form"
      onSubmit={handleSubmit}
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
            setName(event.target.value)
          }
          maxLength={120}
          required
        />
      </div>

      <button
        className="button"
        type="submit"
        disabled={submitting}
      >
        {submitting
          ? "Creating workspace…"
          : "Create Workspace"}
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