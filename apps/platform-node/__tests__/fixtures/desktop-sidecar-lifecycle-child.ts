import { installDesktopSidecarLifecycle } from '../../src/desktop-sidecar-lifecycle.ts';

installDesktopSidecarLifecycle();
console.log('desktop sidecar lifecycle child armed');
setInterval(() => {}, 60_000);
