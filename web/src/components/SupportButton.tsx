// "Buy me a coffee" tip jar in the header. PayPal.me works instantly with just
// the username. To use Stripe instead (lower fees, card-only checkout, your own
// branding): create a Payment Link in the Stripe dashboard
// (Payment Links → new → "let customers choose what to pay") and paste its
// https://buy.stripe.com/... URL here. That's the only change needed.
const SUPPORT_URL = 'https://paypal.me/copyjosh';

export function SupportButton() {
  return (
    <a
      className="btn coffee small"
      href={SUPPORT_URL}
      target="_blank"
      rel="noreferrer noopener"
      title="Buy me a coffee"
      style={{ padding: '6px 12px', textDecoration: 'none' }}
    >
      Support ☕
    </a>
  );
}
