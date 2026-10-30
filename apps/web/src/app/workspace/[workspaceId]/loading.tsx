export default function WorkspaceLoading() {
  return (
    <section
      aria-busy="true"
      aria-labelledby="workspace-loading-title"
      className="protected-wrap workspace-page"
    >
      <header className="protected-header">
        <p className="eyebrow">Workspace</p>
        <h2 id="workspace-loading-title">Loading workspace</h2>
        <p>Paylore is retrieving the latest workspace information.</p>
      </header>
      <section className="surface-card" aria-label="Workspace loading status">
        <p className="loading-indicator" role="status" aria-live="polite">
          <span className="loading-indicator__icon" aria-hidden="true" />
          Loading workspace data…
        </p>
      </section>
    </section>
  );
}
