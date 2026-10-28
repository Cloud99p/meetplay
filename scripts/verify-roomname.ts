// RED/GREEN: prove the sanitizer works, and that the old code path was broken.
import { cleanRoomName, MAX_ROOM_NAME_LENGTH } from '../server/src/utils/roomName.ts';

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
};

console.log('===== the exact payload the security probe got 201 on =====');
check('script tag stripped', cleanRoomName('<script>alert(1)</script>').value, 'scriptalert(1)/script');
check('alteration reported', cleanRoomName('<script>x</script>').altered, true);

console.log('\n===== length cap (probe stored 5000 chars) =====');
const long = 'x'.repeat(5000);
check('capped at max', cleanRoomName(long).value.length, MAX_ROOM_NAME_LENGTH);

console.log('\n===== control characters =====');
check('newline removed', cleanRoomName('a\nb\rc').value, 'abc');
check('null byte removed', cleanRoomName('a\u0000b').value, 'ab');

console.log('\n===== normal names are untouched =====');
check('plain', cleanRoomName('Weekly Sync').value, 'Weekly Sync');
check('not altered', cleanRoomName('Weekly Sync').altered, false);
check('unicode kept', cleanRoomName('Réunion équipe 🎉').value, 'Réunion équipe 🎉');
check('inner spaces kept', cleanRoomName('  Team  Standup  ').value, 'Team  Standup');

console.log('\n===== edge cases =====');
check('empty string -> undefined', cleanRoomName('').value, undefined);
check('whitespace only -> undefined', cleanRoomName('   ').value, undefined);
check('markup only -> undefined', cleanRoomName('<><>').value, undefined);
check('null -> undefined', cleanRoomName(null).value, undefined);
check('undefined -> undefined', cleanRoomName(undefined).value, undefined);
check('number -> undefined', cleanRoomName(42).value, undefined);
check('object -> undefined', cleanRoomName({}).value, undefined);

console.log('\n===== truncation leaves no dangling whitespace =====');
const pad = 'a'.repeat(MAX_ROOM_NAME_LENGTH - 1) + ' ' + 'b'.repeat(20);
const cut = cleanRoomName(pad).value;
check('no trailing space', cut.endsWith(' '), false);
check('never exceeds cap', cut.length <= MAX_ROOM_NAME_LENGTH, true);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
