export default function WorkspaceNotFound() {
  return (
    <div className="protected-wrap">
      <section
        className="invite-state"
        role="alert"
      >
        <p className="eyebrow">
          Workspace access
        </p>

        <h1>
          You do not have access to this workspace.
        </h1>

        <p>
          Check that you are signed in with
          the wallet associated with the
          workspace.
        </p>
      </section>
    </div>
  );
}