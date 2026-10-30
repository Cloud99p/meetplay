/**
 * Prints the CSP that server boot would emit, for the given env.
 * Used to eyeball the policy without starting Fastify.
 */
import { buildCsp } from '../server/src/csp.ts';

const livekitUrl = process.env.LIVEKIT_URL ?? '';
const recordingBaseUrl = process.env.S3_PUBLIC_BASE_URL ?? process.env.R2_PUBLIC_BASE_URL ?? '';

console.log('LIVEKIT_URL      =', livekitUrl || '(unset)');
console.log('RECORDING_BASE   =', recordingBaseUrl || '(unset)');
console.log('');
console.log(buildCsp({ livekitUrl, recordingBaseUrl }));
