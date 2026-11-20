import assert from 'node:assert/strict';

/**
 * The agent never runs an action its vetoes refuse. It tells the model (`rejected_last_turn`) and plans again, and a
 * model that keeps proposing the same refused action is stopped: with the reason, or by handing the question to the user.
 * @param {(body: any) => Promise<any>} planner @param {any} input @param {RegExp} reason checked when the run ends with an error
 */
export async function assertRefused(planner, input, reason) {
  let first;
  try { first = await planner(input); } catch (error) { assert.match(error.message, reason); return; }
  assert.deepEqual(first.actions, [], 'a refused action must not be sent to the page');
  assert.notEqual(first.status, 'ready_for_review');
  let ended = false;
  for (let turn = 0; turn < 6 && !ended; turn += 1) {
    try {
      const next = await planner(input);
      assert.deepEqual(next.actions, [], 'a refused action must not be sent to the page');
      ended = next.status === 'ask_user';
    } catch (error) {
      assert.match(error.message, reason);
      ended = true;
    }
  }
  assert.ok(ended, 'a model that keeps proposing a refused action must be stopped');
}
