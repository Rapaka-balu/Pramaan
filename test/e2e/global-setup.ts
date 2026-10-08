import { startDemo } from '../../fixtures/demo-hrms/server.mjs';

export default async function globalSetup(): Promise<() => Promise<void>> {
  const demo = await startDemo({ port: 0, env: { ...process.env, DEMO_BUGS: 'none' } });
  process.env['DEMO_PORT'] = String(demo.port);
  process.env['DEMO_URL'] = demo.url;
  return async () => {
    await demo.close();
  };
}
