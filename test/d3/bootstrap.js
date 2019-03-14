console.log(`loading bootstrap`);
const harden = require('@agoric/harden');

export default function setup(helpers) {
  const { log } = helpers;
  log(`bootstrap called`);
  const { E, dispatch, registerRoot } = helpers.makeLiveSlots(helpers.vatID);
  const obj0 = {
    bootstrap(argv, vats) {
      helpers.log(`bootstrap.obj0.bootstrap()`);
      console.log(`obj0.bootstrap`, argv, vats);
      E(vats.left).foo(1, vats.right);
    },
  };

  registerRoot(harden(obj0));
  return dispatch;
}