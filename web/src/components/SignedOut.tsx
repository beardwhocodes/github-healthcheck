import { Brand } from './Brand.js';
import { Footer } from './Footer.js';
import { Landing } from './Landing.js';

// The entire signed-out experience: header, marketing landing, footer. Shared by
// the live app (App, when there's no session) and the build-time prerender, so
// crawlers and no-JS visitors receive this exact HTML in the initial response.
export function SignedOut() {
  return (
    <>
      <header className="header">
        <Brand />
      </header>
      <Landing />
      <Footer />
    </>
  );
}
