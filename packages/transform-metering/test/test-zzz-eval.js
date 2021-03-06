/* global Compartment lockdown */
import {
  tameMetering,
  SES1TameMeteringShim,
  SES1ReplaceGlobalMeter,
} from '@agoric/tame-metering';

import test from 'tape-promise/tape';
import * as babelCore from '@babel/core';

import SES1 from 'ses';

// Here's how we can try lockdown.
// import { lockdown } from '@agoric/tame-metering/src/ses.esm.js';

import { makeMeter, makeMeteredEvaluator } from '../src/index';

let replaceGlobalMeter;
let makeEvaluator;
let sesRealm;

// Find out whether we are using the lockdown() or SES1 API.
if (typeof lockdown !== 'undefined') {
  console.error(
    'May be blocked by https://github.com/Agoric/SES-beta/issues/8',
  );

  // Do our taming of the globals,
  replaceGlobalMeter = tameMetering();
  // then lock down the rest of SES.
  lockdown();

  // Our SES evaluator uses a Compartment.
  makeEvaluator = opts => {
    const c = new Compartment(undefined, undefined, opts);
    return {
      evaluate(src, endowments = {}) {
        return c.evaluate(src, { endowments });
      },
    };
  };
} else {
  sesRealm = SES1.makeSESRootRealm({
    consoleMode: 'allow',
    errorStackMode: 'allow',
    shims: [SES1TameMeteringShim],
    configurableGlobals: true,
  });
  replaceGlobalMeter = SES1ReplaceGlobalMeter(sesRealm);
  makeEvaluator = opts => {
    const c = sesRealm.global.Realm.makeCompartment(opts);
    // FIXME: This call should be unnecessary.
    // We currently need it because fresh Compartments
    // do not inherit the configured stable globals.
    Object.defineProperties(
      c.global,
      Object.getOwnPropertyDescriptors(sesRealm.global),
    );
    return c;
  };
}

test('metering evaluator', async t => {
  const rejectionHandler = (_e, _promise) => {
    // console.log('have', e);
  };
  try {
    process.on('unhandledRejection', rejectionHandler);
    const { meter, refillFacet } = makeMeter();

    const refillers = new Map();
    refillers.set(meter, () => Object.values(refillFacet).forEach(r => r()));

    const meteredEval = makeMeteredEvaluator({
      replaceGlobalMeter,
      refillMeterInNewTurn: m => {
        const refiller = refillers.get(m);
        if (refiller) {
          // NOTE: Can check m.isExhausted() to see if the meter
          // is exhausted and decide whether or not to refill based
          // on that.
          refiller();
        }
      },
      babelCore,
      makeEvaluator,
      quiesceCallback: cb => setTimeout(cb),
    });

    // Destructure the output of the meteredEval.
    let exhaustedTimes = 0;
    let expectedExhaustedTimes = 0;
    const myEval = (m, src, endowments = {}) => {
      // Refill the meter as we're just starting the turn.
      return meteredEval(m, src, endowments).then(evalReturn => {
        const [normalReturn, value, metersSeen] = evalReturn;
        t.deepEqual(metersSeen, [meter], 'my meter was the only one seen');
        const e = meter.isExhausted();
        if (e) {
          exhaustedTimes += 1;
          throw e;
        }
        if (!normalReturn) {
          throw value;
        }
        return value;
      });
    };

    /*
    const fakeMeter = {
      isExhausted() { return false; },
      a(...args) { console.log('a', ...args) },
      c(...args) { console.log('c', ...args) },
      l(...args) { console.log('l', ...args) },
      e(...args) { console.log('e', ...args) },
    };
    */
    const src1 = `123; 456;`;
    t.equals(await myEval(meter, src1), 456, 'trivial source succeeds');

    const src5a = `\
('x'.repeat(1e8), 0)
`;
    expectedExhaustedTimes += 1;
    await t.rejects(
      myEval(meter, src5a),
      /Allocate meter exceeded/,
      'big string exhausts',
    );

    const src5 = `\
(new Array(1e9), 0)
`;
    expectedExhaustedTimes += 1;
    await t.rejects(
      myEval(meter, src5),
      /Allocate meter exceeded/,
      'big array exhausts',
    );

    const src2 = `\
function f(a) {
  return f(a + 1) + f(a + 2);
}
f(1);
`;
    expectedExhaustedTimes += 1;
    await t.rejects(
      myEval(meter, src2),
      /Stack meter exceeded/,
      'stack overflow exhausts',
    );

    const src3 = `\
while (true) {}
`;
    expectedExhaustedTimes += 1;
    await t.rejects(
      myEval(meter, src3),
      /Compute meter exceeded/,
      'infinite loop exhausts',
    );

    const src3b = `\
(() => { while(true) {} })();
`;
    expectedExhaustedTimes += 1;
    await t.rejects(
      myEval(meter, src3b),
      /Compute meter exceeded/,
      'nested loop exhausts',
    );

    const src3a = `\
Promise.resolve().then(
  () => {
    while(true) {}
  });
0
`;
    expectedExhaustedTimes += 1;
    await t.rejects(
      myEval(meter, src3a),
      /Compute meter exceeded/,
      'promised infinite loop exhausts',
    );

    const src3c = `\
function f() {
  Promise.resolve().then(f);
}
f();
0
`;
    expectedExhaustedTimes += 1;
    await t.rejects(
      myEval(meter, src3c),
      / meter exceeded/,
      'promise loop exhausts',
    );

    const src4 = `\
/(x+x+)+y/.test('x'.repeat(10000));
`;
    t.equals(
      await myEval(meter, src4),
      false,
      `catastrophic backtracking doesn't happen`,
    );

    const src6 = `\
new Array(1e8).map(Object.create); 0
`;
    expectedExhaustedTimes += 1;
    await t.rejects(
      myEval(meter, src6),
      /Allocate meter exceeded/,
      'long map exhausts',
    );

    t.equals(
      exhaustedTimes,
      expectedExhaustedTimes,
      `meter was exhausted ${expectedExhaustedTimes} times`,
    );
  } catch (e) {
    t.isNot(e, e, 'unexpected exception');
  } finally {
    process.off('unhandledRejection', rejectionHandler);
    t.end();
  }
});
