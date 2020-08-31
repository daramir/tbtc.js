#!/usr/bin/env node --experimental-modules
import Subproviders from "@0x/subproviders"
import Web3 from "web3"
import ProviderEngine from "web3-provider-engine"
import WebsocketSubprovider from "web3-provider-engine/subproviders/websocket.js"
import TBTC from "../index.js"
import { parseDepositCommand } from "./commands/deposit.js"
import {
  findAndConsumeArgsExistence,
  findAndConsumeArgsValues
} from "./helpers.js"
import AvailableConfigs from "./config.json"
/** @typedef {import('../src/TBTC.js').ElectrumConfig} ElectrumConfig */
/** @typedef {import('../src/TBTC.js').TBTC} TBTCInstance */
/** @typedef {import('../src/Deposit.js').default} Deposit */
/** @typedef {import('bn.js')} BN */

/**
 * An action that runs a set command on a given TBTC instance and returns a
 * string for console output.
 *
 * @callback CommandAction
 * @param {TBTCInstance} tbtc An initialized TBTC instance.
 * @return {Promise<string>} The output of the command.
 */

// --------------------------------- ARGS --------------------------------------
let args = process.argv.slice(2)
if (process.argv[0].includes("tbtc.js")) {
  args = process.argv.slice(1) // invoked directly, no node
}

// No debugging unless explicitly enabled.
const {
  found: { debug },
  remaining: flagArgs
} = findAndConsumeArgsExistence(args, "--debug")
if (!debug) {
  console.debug = () => {}
}

const {
  found: { mnemonic, account, rpc },
  remaining: commandArgs
} = findAndConsumeArgsValues(flagArgs, "--mnemonic", "--account", "--rpc")
const engine = new ProviderEngine({ pollingInterval: 1000 })

engine.addProvider(
  // For address 0x420ae5d973e58bc39822d9457bf8a02f127ed473.
  new Subproviders.PrivateKeyWalletSubprovider(
    mnemonic ||
      "b6252e08d7a11ab15a4181774fdd58689b9892fe9fb07ab4f026df9791966990"
  )
)
engine.addProvider(
  new WebsocketSubprovider({
    rpcUrl:
      rpc || "wss://ropsten.infura.io/ws/v3/414a548bc7434bbfb7a135b694b15aa4",
    debug,
    origin: undefined
  })
)

// -------------------------------- SETUP --------------------------------------
// @ts-ignore Web3's provider interface seems to be inaccurate with respect to
// what actually works, since ProviderEngine works just fine here.
const web3 = new Web3(engine)
engine.start()

/** @type {CommandAction | null} */
let action = null

switch (commandArgs[0]) {
  case "deposit":
    action = parseDepositCommand(web3, args.slice(1))
    break
  case "lot-sizes":
    if (args.length == 1) {
      action = async tbtc => {
        return (await tbtc.Deposit.availableSatoshiLotSizes())
          .map(_ => _.toString())
          .join("\n")
      }
    }
    break
  case "supply":
    if (args.length == 1) {
      action = async tbtc => {
        return await tbtc.depositFactory
          .vendingMachine()
          .methods.getMintedSupply()
          .call()
      }
    }
    break
  case "supply-cap":
    if (args.length == 1) {
      action = async tbtc => {
        return await tbtc.depositFactory
          .vendingMachine()
          .methods.getMaxSupply()
          .call()
      }
    }
    break
}

if (action === null) {
  console.log(`
Unknown command ${args[0]} or bad parameters.

Supported flags:
    --debug
        Enable debug output.

    --rpc <rpc-url>
        Set RPC URL to the specified value.

    --mnemonic <mnemonic>
        Use the specified for the operating account. Also supports private key
        strings, since the underlying provider accepts these.

    --account <account>
        Use the specified account for all transactions. If --mnemonic is
        specified, it must be able to sign for this account in order for
        mutating transactions to be sent to the Ethereum chain. If this is
        left off, the first account for the private key is used.

Supported commands:
    deposit new [--no-mint] <lot-size-satoshis>
        Initiates a deposit funding flow. Takes the lot size in satoshis.
        Will prompt with a Bitcoin address when funding needs to be
        submitted. When the flow completes, outputs the deposit as a single
        tab-delimited line with the deposit address, current deposit state,
        the deposit lot size in satoshis, and, when applicable, the minted
        amount of TBTC.

        --no-mint
            Specifies not to mint TBTC once the deposit is qualified.

    deposit list [--vending-machine] [--address <address>]
        With no options, lists the deposits currently owned by the web3
        account address. Deposits are output as tab-delimited lines that
        include the deposit address, current deposit state, and deposit
        lot size in satoshis.

        --vending-machine
            Lists the deposits currently owned by the vending machine.

        --address <address>
            Lists the deposits currently owned by the specified address.

    deposit <address> [<resume|redeem|liquidate|withdraw>]
        Operations on a particular address. If no command is provided,
        outputs the deposit as a single tab-delimited line with the deposit
        address, current deposit state, and deposit lot size in satoshis.

        resume [--funding|--redemption] [--no-mint]
            Resumes a funding or redemption flow, depending on the deposit's
            current state. When the flow completes, outputs the deposit as a
            single tab-delimited line with the deposit address, current
            deposit state, and deposit lot size in satoshis.

            --funding
                Only resumes the funding flow and outputs the final deposit
                state; if the deposit is not mid-funding, does not resume and
                outputs an error.

                --no-mint
                    When resuming a funding flow, if the deposit is not already
                    mid-minting, specifies not to mint TBTC once the deposit is
                    qualified.

            --redemption
                Only resumes a flow if it is a redemption flow and outputs
                the final deposit state; if the deposit is not mid-redemption,
                does not resume and outputs an error.

        redeem <bitcoin-address>
            Initiates a deposit redemption flow that will redeem the deposit's
            BTC to the specified Bitcoin address. When the flow completes,
            outputs the deposit as a single tab-delimited line with the
            deposit address, current deposit state, deposit lot size in
            satoshis, and the transaction hash of the redemption Bitcoin
            transaction.

        courtesy-call
            Attempts to notify the deposit it is undercollateralized and
            should transition into courtesy call.

        liquidate [--for <funding-timeout|undercollateralization|courtesy-timeout|redemption-timeout>]
            Attempts to liquidate the deposit, reporting back the status of
            the liquidation . By default, looks for any available reason to
            liquidate. When the flow completes, outputs the deposit as a
            single tab-delimited line with the deposit address, current
            deposit state, deposit lot size in satoshis, and the liquidation
            status (\`liquidated\`, \`in-auction\`, or \`failed\`).

            --for <funding-timeout|undercollateralization|courtesy-timeout|redemption-timeout>
                If specified, only triggers liquidation for the specified
                reason. If the reason does not apply, reports \`not-applicable\`
                status.

        withdraw [--dry-run]
            Attempts to withdraw the current account's allowance from a tBTC
            deposit. Only the amount allowed for the current account is
            withdrawn. Outputs the withdrawn amount in wei once withdrawal
            is complete.

            --dry-run
                Outputs the amount that would be withdrawn in wei, but does
                not broadcast the transaction to withdraw it.

    lot-sizes
        Returns a list of the currently available lot sizes, one per line.

    supply
        Returns the current supply as a decimal amount in TBTC. 18 decimals of
        precision, but with a decimal point.

    supply-cap
        Returns the current supply cap as a decimal amount in TBTC.
    `)

  process.exit(1)
}

/**
 * @param {CommandAction} action
 * @return {Promise<string>}
 */
async function runAction(action) {
  web3.eth.defaultAccount = account || (await web3.eth.getAccounts())[0]
  const chainId = await web3.eth.getChainId()
  // @ts-ignore TypeScript mad.
  const config = AvailableConfigs[chainId.toString()]

  const tbtc = await TBTC.withConfig({
    web3: web3,
    bitcoinNetwork: config.bitcoinNetwork,
    electrum: config.electrum
  })

  return action(tbtc)
}

runAction(/** @type {CommandAction} */ (action))
  .then(result => {
    console.log(result)

    process.exit(0)
  })
  .catch(error => {
    console.error("ERROR ", error)

    process.exit(1)
  })
