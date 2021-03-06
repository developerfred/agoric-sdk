/* global replaceGlobalMeter, registerEndOfCrank */
// Copyright (C) 2019 Agoric, under Apache License 2.0

import Nat from '@agoric/nat';
import harden from '@agoric/harden';
import makeStore from '@agoric/store';
import { assert, details } from '@agoric/assert';
import {
  allComparable,
  mustBeSameStructure,
  sameStructure,
} from '@agoric/same-structure';
import produceIssuer from '@agoric/ertp';
import { producePromise } from '@agoric/produce-promise';
import { makeMeter } from '@agoric/transform-metering/src/meter';

export { makeCollect } from './makeCollect';

/**
 * Make a reusable host that can reliably install and execute contracts.
 *
 * @param E eventual-send method proxy
 * @param evaluate function to evaluate with endowments
 * @param additionalEndowments pure or pure-ish endowments to add to evaluator
 */
function makeContractHost(E, evaluate, additionalEndowments = {}) {
  // Maps from seat identity to seats
  const seats = makeStore('seatIdentity');
  // from seat identity to invite description.
  const seatDescriptions = makeStore('seatIdentity');
  // from installation to source code string
  const installationSources = makeStore('installation');

  const {
    mint: inviteMint,
    issuer: inviteIssuer,
    amountMath: inviteAmountMath,
  } = produceIssuer('contract host', 'set');

  function redeem(allegedInvitePayment) {
    return inviteIssuer.getAmountOf(allegedInvitePayment).then(inviteAmount => {
      assert(!inviteAmountMath.isEmpty(inviteAmount), details`No invites left`);
      const [{ seatIdentity }] = inviteAmountMath.getExtent(inviteAmount);
      return Promise.resolve(
        inviteIssuer.burn(allegedInvitePayment, inviteAmount),
      ).then(_ => seats.get(seatIdentity));
    });
  }

  const defaultEndowments = {
    Nat,
    harden,
    console,
    E,
    producePromise,
    // TODO: sameStructure is used in one check...() function. Figure out a
    // more general approach to providing useful helpers.
    // The best approach is to use the `getExport` moduleFormat, and
    // bundle imported modules that implement the things we want to use.
    sameStructure,
    mustBeSameStructure,
  };

  const fullEndowments = Object.create(null, {
    ...Object.getOwnPropertyDescriptors(defaultEndowments),
    ...Object.getOwnPropertyDescriptors(additionalEndowments),
  });

  function evaluateStringToFn(functionSrcString) {
    // TODO these function strings shoudl be `details` but that disrupts tests
    assert(
      typeof functionSrcString === 'string',
      `"${functionSrcString}" must be a string, but was ${typeof functionSrcString}`,
    );

    // FIXME: Defeat ESM!
    functionSrcString = functionSrcString.replace(
      /sameStructure\.((mustBeS|s)ameStructure)/g,
      '$1',
    );

    // Refill a meter each crank.
    const { meter, refillFacet } = makeMeter();
    const doRefill = () => {
      if (!meter.isExhausted()) {
        // We'd like to have fail-stop semantics, which means we associate
        // a meter with a spawn and not with an installation, and failed
        // spawns die forever.  Check functions, on the other hand, should
        // be billed to the installation, which may die forever.

        // Refill the meter, since we're leaving a crank.
        refillFacet.combined();
      }
    };

    // Make an endowment to get our meter.
    const getMeter = m => {
      if (m !== true && typeof replaceGlobalMeter !== 'undefined') {
        // Replace the global meter and register our refiller.
        replaceGlobalMeter(meter);
      }
      if (typeof registerEndOfCrank !== 'undefined') {
        // Register our refiller.
        registerEndOfCrank(doRefill);
      }
      return meter;
    };

    // Inject the evaluator.
    const nestedEvaluate = src => {
      const allEndowments = {
        ...fullEndowments,
        getMeter,
        nestedEvaluate,
      };
      // console.log(allEndowments, src);
      return evaluate(src, allEndowments);
    };

    const fn = nestedEvaluate(functionSrcString);
    assert(
      typeof fn === 'function',
      `"${functionSrcString}" must be a string for a function, but produced ${typeof fn}`,
    );
    return fn;
  }

  /**
   * Build an object containing functions with names starting with 'check' from
   * strings in the input contract.
   */
  function extractCheckFunctions(contractSrcs) {
    const installation = {};
    for (const fname of Object.getOwnPropertyNames(contractSrcs)) {
      if (typeof fname === 'string' && fname.startsWith('check')) {
        const fn = evaluateStringToFn(contractSrcs[fname]);
        installation[fname] = (...args) => fn(installation, ...args);
      }
    }
    return installation;
  }

  /** The contract host is designed to have a long-lived credible identity. */
  const contractHost = harden({
    getInviteIssuer() {
      return inviteIssuer;
    },
    // contractSrcs is a record containing source code for the functions
    // comprising a contract. `spawn` evaluates the `start` function
    // (parameterized by `terms` and `inviteMaker`) to start the contract, and
    // returns whatever the contract returns. The contract can also have any
    // number of functions with names beginning 'check', each of which can be
    // used by clients to help validate that they have terms that match the
    // contract.
    install(contractSrcs, moduleFormat = 'object') {
      let installation;
      if (moduleFormat === 'object') {
        installation = extractCheckFunctions(contractSrcs);
      } else if (
        moduleFormat === 'getExport' ||
        moduleFormat === 'nestedEvaluate'
      ) {
        // We don't support 'check' functions in getExport format,
        // because we only do a single evaluate, and the whole
        // contract must be metered per-spawn, not per-installation.
        installation = {};
      } else {
        assert.fail(details`Unrecognized moduleFormat ${moduleFormat}`);
      }

      // TODO: The `spawn` method should spin off a new vat for each new
      // contract instance.  In the current single-vat implementation we
      // evaluate the contract's start function during install rather than
      // spawn. Once we spin off a new vat per spawn, we'll need to evaluate it
      // per-spawn. Even though we do not save on evaluations, this currying
      // enables us to avoid (for now) re-sending the contract source code, and
      // it enables us to use the installation in descriptions rather than the
      // source code itself. The check... methods must be evaluated on install,
      // since they become properties of the installation.
      function spawn(termsP) {
        let startFn;
        if (moduleFormat === 'object') {
          startFn = evaluateStringToFn(contractSrcs.start);
        } else if (
          moduleFormat === 'getExport' ||
          moduleFormat === 'nestedEvaluate'
        ) {
          // We support getExport because it is forward-compatible with nestedEvaluate.
          const getExports = evaluateStringToFn(contractSrcs);
          const ns = getExports();
          startFn = ns.default;
        } else {
          assert.fail(details`Unrecognized moduleFormat ${moduleFormat}`);
        }

        return Promise.resolve(allComparable(termsP)).then(terms => {
          const inviteMaker = harden({
            // Used by the contract to make invites for credibly
            // participating in the contract. The returned invite
            // can be redeemed for this seat. The inviteMaker
            // contributes the description `{ installation, terms,
            // seatIdentity, seatDesc }`. If this contract host
            // redeems an invite, then the contractSrc and terms are
            // accurate. The seatDesc is according to that
            // contractSrc code.
            make(seatDesc, seat) {
              const seatIdentity = harden({});
              const seatDescription = harden([
                {
                  installation,
                  terms,
                  seatIdentity,
                  seatDesc,
                },
              ]);
              seats.init(seatIdentity, seat);
              seatDescriptions.init(seatIdentity, seatDescription);
              const inviteAmount = inviteAmountMath.make(seatDescription);
              // This should be the only use of the invite mint, to
              // make an invite payment whose extent describes this
              // seat.
              return inviteMint.mintPayment(inviteAmount);
            },
            redeem,
          });
          return startFn(terms, inviteMaker);
        });
      }

      installation.spawn = spawn;
      harden(installation);
      installationSources.init(installation, contractSrcs);
      return installation;
    },

    // Verify that this is a genuine installation and show its source
    // code. Thus, all genuine installations are transparent if one
    // has their contractHost.
    getInstallationSourceCode(installationP) {
      return Promise.resolve(installationP).then(installation =>
        installationSources.get(installation),
      );
    },

    // If this is an invite payment made by an inviteMaker of this contract
    // host, redeem it for the associated seat. Else error. Redeeming
    // consumes the invite payment and also transfers the use rights.
    redeem(allegedInvitePaymentP) {
      return Promise.resolve(allegedInvitePaymentP).then(
        allegedInvitePayment => {
          return redeem(allegedInvitePayment);
        },
      );
    },
  });
  return contractHost;
}
harden(makeContractHost);

export { makeContractHost };
