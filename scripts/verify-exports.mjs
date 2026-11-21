// Resolves both subpaths by package name from CommonJS and ESM (run after build).
import { createRequire } from 'node:module';

const subpaths = ['migrations', 'agentConfig'];
const name = '@jarnold-bdai/platform';
const require = createRequire(import.meta.url);

for (const sub of subpaths) {
  const id = `${name}/${sub}`;
  require(id);
  await import(id);
  console.log(`ok ${id} (require + import)`);
}
// Root entry point must not exist.
for (const loader of [() => require(name), () => import(name)]) {
  let threw = false;
  try { await loader(); } catch { threw = true; }
  if (!threw) throw new Error('root entry point must not exist');
}
