// Starts and closes the browser three times, then counts zombie processes:
// ended processes that wait for their parent to collect them.
import { readdirSync, readFileSync } from 'node:fs';
import { launch, library } from './launch.mjs';

for (let i = 0; i < 3; i++) {
  const browser = await launch();
  await browser.close();
}
await new Promise((resolve) => setTimeout(resolve, 1000));

const zombies = [];
for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
  try {
    // /proc/<pid>/stat: "<pid> (<name>) <state> <parent pid> ..."
    const [, name, state, parent] = readFileSync(`/proc/${pid}/stat`, 'utf8').match(/^\d+ \((.*)\) (\S) (\d+)/);
    if (state === 'Z') zombies.push(`${name} (parent ${parent})`);
  } catch {
    // The process ended while we read the list.
  }
}
console.log(`${library}: node has PID ${process.pid}, zombie processes: ${zombies.length}`);
for (const zombie of zombies) console.log(`  ${zombie}`);
