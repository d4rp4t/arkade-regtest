// Solver bring-up. solverd initialises its wallet from SOLVER_WALLET_SEED on
// boot (no post-start API dance), so this just waits until its HTTP listener
// answers. It depends on arkd and the emulator, both of which the start flow
// has already made ready before this runs.
import { env } from '../env.mjs';
import { log } from '../log.mjs';
import { waitForOrFail, fetchText } from '../wait.mjs';

export async function setupSolver() {
  const port = env('SOLVER_HTTP_PORT', '7091');
  await waitForOrFail(
    'solver HTTP API',
    async () => {
      // Any HTTP response (even a 404) means solverd is listening and past init.
      const { ok, status } = await fetchText(`http://localhost:${port}/`, { timeoutMs: 5000 });
      return ok || status > 0;
    },
    { attempts: 45, intervalMs: 2000 },
  );
  log(`Solver up at http://localhost:${port}`);
}
