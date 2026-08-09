// Verify loadConfig() THROWS in production mode when JWT_SECRET is unset.
// Run as child process with NODE_ENV=production. Prints THREW_AS_EXPECTED on success.
import { loadConfig } from '../server/src/config.ts';

let threw = false;
try {
  loadConfig();
} catch {
  threw = true;
}
console.log(threw ? 'THREW_AS_EXPECTED' : 'DID_NOT_THROW');
process.exit(threw ? 0 : 1);
