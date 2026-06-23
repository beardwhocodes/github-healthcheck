// The product wordmark shown in the header on every view. Extracted so both the
// live app and the build-time prerender can render it.
export function Brand() {
  return (
    <div className="brand">
      <img className="logo" src="/logo.png" alt="" width={32} height={32} />
      <div>
        GitHub Healthcheck
        <small>GitHub malware &amp; clone scanner</small>
      </div>
    </div>
  );
}
