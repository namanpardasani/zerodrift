import { Brand, Button } from '@zerodrift/ui';
import { Link } from 'react-router-dom';

/** 404 in the product's voice. Inside the app it sits in the page area; outside it is a full page. */
export function NotFoundPage({ inApp }: { inApp?: boolean }) {
  const body = (
    <div className="mx-auto max-w-md py-16 text-center">
      <div className="mono text-[64px] font-medium leading-none text-ink">404</div>
      <h1 className="mt-5 text-[22px] font-medium tracking-[-0.015em]">this account doesn’t exist in the books.</h1>
      <p className="mt-2 text-sm text-muted">No page lives at this address. Nothing was created, nothing was moved.</p>
      <div className="mt-6 flex justify-center gap-2">
        <Link to={inApp ? '/app' : '/'}>
          <Button variant="primary">{inApp ? 'Back to overview' : 'Back home'}</Button>
        </Link>
      </div>
    </div>
  );
  if (inApp) return body;
  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <div className="px-6 py-5">
        <Link to="/" aria-label="Home"><Brand /></Link>
      </div>
      <div className="flex flex-1 items-center">{body}</div>
    </div>
  );
}
