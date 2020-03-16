// eslint-disable-next-line import/no-extraneous-dependencies
import { test } from 'tape-promise/tape';
// eslint-disable-next-line import/no-extraneous-dependencies
import bundleSource from '@agoric/bundle-source';

import harden from '@agoric/harden';

import { makeZoe } from '../../../src/zoe';
import { setup } from '../setupBasicMints';

const atomicSwapRoot = `${__dirname}/../../../src/contracts/atomicSwap`;

test('zoe - atomicSwap', async t => {
  try {
    const { issuers, mints, moola, simoleans } = setup();
    const zoe = makeZoe({ require });
    const inviteIssuer = zoe.getInviteIssuer();
    const [moolaIssuer, simoleanIssuer] = issuers;
    const [moolaMint, simoleanMint] = mints;

    // pack the contract
    const { source, moduleFormat } = await bundleSource(atomicSwapRoot);
    // install the contract
    const installationHandle = zoe.install(source, moduleFormat);

    // Setup Alice
    const aliceMoolaPayment = moolaMint.mintPayment(moola(3));
    const aliceMoolaPurse = moolaIssuer.makeEmptyPurse();
    const aliceSimoleanPurse = simoleanIssuer.makeEmptyPurse();

    // Setup Bob
    const bobSimoleanPayment = simoleanMint.mintPayment(simoleans(7));
    const bobMoolaPurse = moolaIssuer.makeEmptyPurse();
    const bobSimoleanPurse = simoleanIssuer.makeEmptyPurse();

    // 1: Alice creates an atomicSwap instance
    const roles = harden({ Asset: moolaIssuer, Price: simoleanIssuer });
    const aliceInvite = await zoe.makeInstance(installationHandle, roles);

    // 2: Alice escrows with zoe
    const aliceOfferRules = harden({
      offer: { Asset: moola(3) },
      want: { Price: simoleans(7) },
      exit: { onDemand: {} },
    });
    const alicePayments = { Asset: aliceMoolaPayment };

    // 3: Alice redeems her invite and escrows with Zoe
    // 4: Alice makes the first offer in the swap.
    const { payout: alicePayoutP, offerResult: bobInviteP } = await zoe.redeem(
      aliceInvite,
      aliceOfferRules,
      alicePayments,
    );

    // 5: Alice spreads the invite far and wide with instructions
    // on how to use it and Bob decides he wants to be the
    // counter-party.

    const bobExclusiveInvite = await inviteIssuer.claim(bobInviteP);
    const bobInviteExtent = inviteIssuer.getAmountOf(bobExclusiveInvite)
      .extent[0];

    const {
      installationHandle: bobInstallationId,
      roles: bobRoles,
    } = zoe.getInstance(bobInviteExtent.instanceHandle);

    t.equals(bobInstallationId, installationHandle, 'bobInstallationId');
    t.deepEquals(bobRoles, { Asset: moolaIssuer, Price: simoleanIssuer });
    t.deepEquals(bobInviteExtent.asset, moola(3));
    t.deepEquals(bobInviteExtent.price, simoleans(7));

    const bobOfferRules = harden({
      offer: { Price: simoleans(7) },
      want: { Asset: moola(3) },
      exit: { onDemand: {} },
    });
    const bobPayments = { Price: bobSimoleanPayment };

    // 6: Bob escrows with zoe
    // 7: Bob makes an offer
    const {
      payout: bobPayoutP,
      offerResult: bobOfferResult,
    } = await zoe.redeem(bobExclusiveInvite, bobOfferRules, bobPayments);

    t.equals(
      bobOfferResult,
      'The offer has been accepted. Once the contract has been completed, please check your payout',
    );
    const bobPayout = await bobPayoutP;
    const alicePayout = await alicePayoutP;

    const bobMoolaPayout = await bobPayout.Asset;
    const bobSimoleanPayout = await bobPayout.Price;

    const aliceMoolaPayout = await alicePayout.Asset;
    const aliceSimoleanPayout = await alicePayout.Price;

    // Alice gets what Alice wanted
    t.deepEquals(
      simoleanIssuer.getAmountOf(aliceSimoleanPayout),
      aliceOfferRules.want.Price,
    );

    // Alice didn't get any of what Alice put in
    t.deepEquals(moolaIssuer.getAmountOf(aliceMoolaPayout), moola(0));

    // Alice deposits her payout to ensure she can
    await aliceMoolaPurse.deposit(aliceMoolaPayout);
    await aliceSimoleanPurse.deposit(aliceSimoleanPayout);

    // Bob deposits his original payments to ensure he can
    await bobMoolaPurse.deposit(bobMoolaPayout);
    await bobSimoleanPurse.deposit(bobSimoleanPayout);

    // Assert that the correct payouts were received.
    // Alice had 3 moola and 0 simoleans.
    // Bob had 0 moola and 7 simoleans.
    t.equals(aliceMoolaPurse.getCurrentAmount().extent, 0);
    t.equals(aliceSimoleanPurse.getCurrentAmount().extent, 7);
    t.equals(bobMoolaPurse.getCurrentAmount().extent, 3);
    t.equals(bobSimoleanPurse.getCurrentAmount().extent, 0);
  } catch (e) {
    t.assert(false, e);
    console.log(e);
  } finally {
    t.end();
  }
});