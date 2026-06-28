export function SuspendedNotice({
  reason,
  onContact,
}: {
  reason: string | null;
  onContact?: () => void;
}) {
  return (
    <div className="card suspended-card">
      <h3 className="section-title">Your account is suspended</h3>
      <p className="muted small" style={{ margin: '6px 0 0', maxWidth: 620 }}>
        Scanning is disabled for this account. This usually happens when our systems detect
        unusually high scan volume or other abuse of the service.
      </p>
      {reason && (
        <div className="banner error mt16">
          <b>Reason:</b> {reason}
        </div>
      )}
      <p className="muted small mt16" style={{ maxWidth: 620 }}>
        If you think this is a mistake, send us a note and we&apos;ll take a look.
      </p>
      {onContact && (
        <button type="button" className="btn mt8" onClick={onContact}>
          Contact us
        </button>
      )}
    </div>
  );
}
