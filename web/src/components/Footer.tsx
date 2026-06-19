export function Footer() {
  return (
    <footer className="footer">
      <span>
        Built by{' '}
        <a href="https://beardwho.codes" target="_blank" rel="noreferrer noopener">
          beardwho.codes
        </a>
      </span>
      <span className="footer-sep" aria-hidden>
        ·
      </span>
      <a href="https://copyjosh.com" target="_blank" rel="noreferrer noopener">
        copyjosh.com
      </a>
      <span className="footer-sep" aria-hidden>
        ·
      </span>
      <a
        href="https://x.com/beardwhocodes"
        target="_blank"
        rel="noreferrer noopener"
        className="footer-x"
        aria-label="@beardwhocodes on X"
        title="@beardwhocodes on X"
      >
        <XIcon />
      </a>
    </footer>
  );
}

function XIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}
