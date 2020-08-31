/** @typedef {import('../tbtc.js').CommandAction} CommandAction */
/** @typedef {import('../../src/TBTC.js').ElectrumConfig} ElectrumConfig */
/** @typedef {import('../../src/TBTC.js').Web3} Web3 */
/** @typedef {import('../../src/TBTC.js').TBTC} TBTCInstance */
/** @typedef {import('../../src/Deposit.js').default} Deposit */
/** @typedef {import('../../src/Deposit.js').RedemptionDetails} RedemptionDetails */
/** @typedef {import('bn.js')} BN */

import EthereumHelpers from "../../src/EthereumHelpers.js"
import Redemption from "../../src/Redemption.js"
import { DepositStates } from "../../src/Deposit.js"
import {
  findAndConsumeArgExistence,
  findAndConsumeArgValue,
  findAndConsumeArgsExistence
} from "../helpers.js"

/**
 * @param {Web3} web3 An initialized Web3 instance TBTC is configured to use.
 * @param {Array<string>} args
 * @return {CommandAction | null}
 */
export function parseDepositCommand(web3, args) {
  if (args.length > 0) {
    const [command, ...commandArgs] = args
    switch (command) {
      case "new":
        {
          const {
            found: { noMint },
            remaining
          } = findAndConsumeArgsExistence(commandArgs, "--no-mint")

          if (remaining.length == 1) {
            const lotSizeSatoshis = web3.utils.toBN(commandArgs[1])
            return async tbtc => {
              return createDeposit(tbtc, lotSizeSatoshis, !noMint)
            }
          } else {
            console.error(
              "No lot size specified. Use lot-sizes to find available lot sizes."
            )
          }
        }
        break
      case "list": {
        const {
          existence: listVendingMachine,
          remaining: postVendingMachine
        } = findAndConsumeArgExistence(commandArgs, "--vending-machine")
        const {
          value: address,
          remaining: postAddress
        } = findAndConsumeArgValue(postVendingMachine, "--address")

        if (postAddress.length == 0) {
          if (address !== null && listVendingMachine) {
            console.error(
              "Vending machine and address flag cannot be specified together."
            )
            break
          }
          if (address !== null && !web3.utils.isAddress(address)) {
            console.error(`Address ${address} is not a valid Ethereum address.`)
            break
          }

          const explicitAddress = address
          return async tbtc => {
            const address = listVendingMachine
              ? tbtc.depositFactory.vendingMachine().options.address
              : explicitAddress !== null
              ? explicitAddress
              : web3.defaultAccount

            return listDeposits(tbtc, address)
          }
        }
      }
      default:
        const depositAddress = command
        const [subcommand, ...subcommandArgs] = commandArgs
        if (!web3.utils.isAddress(depositAddress)) {
          console.error(
            `Deposit address ${depositAddress} is not a valid Ethereum address.`
          )
          break
        }
        if (typeof subcommand == "undefined") {
          return async tbtc =>
            standardDepositOutput(
              tbtc,
              await tbtc.Deposit.withAddress(depositAddress)
            )
        } else if (typeof commandParsers[subcommand] === "undefined") {
          console.error(
            `Invalid command after deposit address; command can be one of:\n` +
              `    ${Object.keys(commandParsers).join(", ")}`
          )
          break
        }

        return commandParsers[subcommand](depositAddress, subcommandArgs)
    }
  }

  // If we're here, no command matched.
  return null
}

/** @enum {{ states: DepositStates[], method: string }} */
const LIQUIDATION_HANDLERS = {
  "setup-timeout": {
    states: [DepositStates.AWAITING_SIGNER_SETUP],
    method: "notifySignerSetupFailed"
  },
  "funding-timeout": {
    states: [DepositStates.AWAITING_BTC_FUNDING_PROOF],
    method: "notifyFundingTimedOut"
  },
  undercollateralization: {
    states: [DepositStates.ACTIVE, DepositStates.COURTESY_CALL],
    method: "notifyUndercollateralizedLiquidation"
  },
  "courtesy-timeout": {
    states: [DepositStates.COURTESY_CALL],
    method: "notifyCourtesyCallExpired"
  },
  "redemption-signature-timeout": {
    states: [DepositStates.AWAITING_WITHDRAWAL_PROOF],
    method: "notifyRedemptionSignatureTimedOut"
  },
  "redemption-proof-timeout": {
    states: [DepositStates.AWAITING_WITHDRAWAL_SIGNATURE],
    method: "notifyRedemptionProofTimedOut"
  }
}

/** @typedef {keyof typeof LIQUIDATION_HANDLERS} AVAILABLE_LIQUIDATION_REASONS */

/**
 * @type {Object.<string,(depositAddress: string, args: string[])=>CommandAction | null>}
 */
const commandParsers = {
  redeem: (depositAddress, args) => {
    const [redemptionBitcoinAddress, ...remaining] = args

    if (!redemptionBitcoinAddress) {
      console.log("Bitcoin address required for redemption.")
      return null
    } else if (remaining.length > 0) {
      return null
    } else {
      return async tbtc => {
        const deposit = await tbtc.Deposit.withAddress(depositAddress)
        return redeemDeposit(tbtc, deposit, "")
      }
    }
  },
  withdraw: (depositAddress, args) => {
    const { existence: onlyCall, remaining } = findAndConsumeArgExistence(
      args,
      "--dry-run"
    )

    if (remaining.length > 0) {
      return null
    } else {
      return async tbtc => withdrawFromDeposit(tbtc, depositAddress, onlyCall)
    }
  },
  resume: (depositAddress, args) => {
    const {
      existence: noMint,
      remaining: postNoMint
    } = findAndConsumeArgExistence(args, "--no-mint")

    const {
      existence: onlyFunding,
      remaining: postFunding
    } = findAndConsumeArgExistence(postNoMint, "--funding")
    const {
      existence: onlyRedemption,
      remaining: postRedemption
    } = findAndConsumeArgExistence(postFunding, "--redemption")

    if (onlyFunding && onlyRedemption) {
      console.error(
        "--funding and --redemption cannot both be specified. Specify neither\n" +
          "if you want to resume all flows no matter the deposit state."
      )
      return null
    } else if (onlyRedemption && noMint) {
      console.error(
        "--redemption specified with --no-mint, but redemption cannot mint."
      )
      return null
    } else if (postRedemption.length > 0) {
      return null
    } else {
      return async tbtc =>
        resumeDeposit(
          tbtc,
          depositAddress,
          onlyFunding,
          onlyRedemption,
          !noMint
        )
    }
  },
  "courtesy-call": (depositAddress, args) => {
    if (args.length > 0) {
      return null
    } else {
      return async tbtc => {
        const deposit = await tbtc.Deposit.withAddress(depositAddress)
        await deposit.notifyCourtesyCall()
        return standardDepositOutput(tbtc, deposit)
      }
    }
  },
  liquidate: (depositAddress, args) => {
    const { value: liquidationReason, remaining } = findAndConsumeArgValue(
      args,
      "for"
    )

    if (liquidationReason && liquidationReason in LIQUIDATION_HANDLERS) {
      console.error(
        `Invalid liquidation reason; only one of these is allowed:\n` +
          `    ${Object.keys(LIQUIDATION_HANDLERS).join(", ")}`
      )
      return null
    } else if (remaining.length > 0) {
      return null
    } else {
      return async tbtc =>
        liquidateDeposit(
          tbtc,
          depositAddress,
          /** @type {AVAILABLE_LIQUIDATION_REASONS} */ (liquidationReason) ||
            undefined
        )
    }
  }
}

/**
 * @param {TBTCInstance} tbtc
 * @param {string | null} ownerAddress
 */
async function listDeposits(tbtc, ownerAddress) {
  return new Promise(async (resolve, reject) => {
    try {
      // Find tokens that were owned by the owner address at any point.
      const ownedDepositTokens = (
        await EthereumHelpers.getExistingEvents(
          tbtc.Deposit.depositToken(),
          "Transfer",
          { to: ownerAddress || "" }
        )
      ).map(
        (/** @type {any} */ _) => /** @type {string} */ (_.returnValues.tokenId)
      )

      // Filter out any that are no longer owned by the owner address.
      const stillOwned = (
        await Promise.all(
          /** @type Promise<[string, boolean]>[] */
          ownedDepositTokens.map(tokenId =>
            tbtc.Deposit.depositToken()
              .methods.ownerOf(tokenId)
              .call()
              .then((/** @type {string} */ _) => [tokenId, _ == ownerAddress])
          )
        )
      )
        .filter(([, ownedByVm]) => ownedByVm)
        .map(([tokenId]) => tokenId)

      const deposits = await Promise.all(
        stillOwned.map(_ => tbtc.Deposit.withTdtId(_))
      )

      const depositInfo = await Promise.all(
        deposits.map(async _ => {
          return standardDepositOutput(tbtc, _)
        })
      )

      resolve(depositInfo.join("\n"))
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * @param {TBTCInstance} tbtc
 * @param {BN} satoshiLotSize
 * @param {boolean} mintOnActive
 * @return {Promise<string>}
 */
async function createDeposit(tbtc, satoshiLotSize, mintOnActive) {
  const deposit = await tbtc.Deposit.withSatoshiLotSize(satoshiLotSize)

  return runDeposit(tbtc, deposit, mintOnActive)
}

/**
 * @param {TBTCInstance} tbtc
 * @param {string} depositAddress
 * @param {boolean} onlyFunding Only resume a funding flow for this deposit.
 * @param {boolean} onlyRedemption Only resume a redemption flow for this deposit.
 * @param {boolean} mintOnActive If in a funding flow, proceed to minting once
 *        deposit is qualified.
 * @return {Promise<string>}
 */
async function resumeDeposit(
  tbtc,
  depositAddress,
  onlyFunding,
  onlyRedemption,
  mintOnActive
) {
  const deposit = await tbtc.Deposit.withAddress(depositAddress)
  const depositState = await deposit.getCurrentState()

  if (
    (onlyFunding && depositState >= tbtc.Deposit.State.ACTIVE) ||
    (onlyRedemption && depositState < tbtc.Deposit.State.ACTIVE)
  ) {
    throw new Error("Nothing to resume for deposit.")
  }

  const existingRedemptionDetails = await deposit.getLatestRedemptionDetails()
  if (existingRedemptionDetails) {
    return redeemDeposit(tbtc, deposit, existingRedemptionDetails)
  } else {
    return runDeposit(tbtc, deposit, mintOnActive)
  }
}

/**
 * @param {TBTCInstance} tbtc
 * @param {Deposit} deposit
 * @param {Object} [alreadyResolved] When specified, carries information about
 *        already-resolved properties of the deposit.
 * @param {number} [alreadyResolved.state] The already-resolved state of the
 *        deposit.
 * @param {BN} [alreadyResolved.lotSizeSatoshis] The already-resolved lot size
 *        of the deposit, in satoshis.
 */
async function standardDepositOutput(tbtc, deposit, alreadyResolved) {
  const resolved = alreadyResolved || {
    state: undefined,
    lotSizeSatoshis: undefined
  }

  const depositState = resolved.state || (await deposit.getCurrentState())
  const stateName = tbtc.Deposit.stateById(depositState)
  const lotSize =
    resolved.lotSizeSatoshis || (await deposit.getLotSizeSatoshis())

  return [deposit.address, stateName, lotSize].join("\t")
}

/**
 * @param {TBTCInstance} tbtc
 * @param {Deposit} deposit
 * @param {RedemptionDetails | string} redemptionInfo When RedemptionDetails,
 *        the details on the existing redemption that should be resumed. When a
 *        string, the Bitcoin address the receiver would like to receive
 *        redeemed BTC at.
 * @return {Promise<string>}
 */
async function redeemDeposit(tbtc, deposit, redemptionInfo) {
  return new Promise(async (resolve, reject) => {
    try {
      let redemption
      if (typeof redemptionInfo == "string") {
        redemption = await deposit.requestRedemption(redemptionInfo)
      } else {
        redemption = new Redemption(deposit, redemptionInfo)
      }
      redemption.autoSubmit()

      redemption.onWithdrawn(transactionID => {
        resolve(standardDepositOutput(tbtc, deposit) + "\t" + transactionID)
      })
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * @param {TBTCInstance} tbtc
 * @param {Deposit} deposit
 * @param {boolean} mintOnActive
 * @return {Promise<string>}
 */
async function runDeposit(tbtc, deposit, mintOnActive) {
  deposit.autoSubmit()

  return new Promise(async (resolve, reject) => {
    deposit.onBitcoinAddressAvailable(async address => {
      // TODO Create a flow where output can be easily used to automate.
      try {
        const lotSize = await deposit.getLotSizeSatoshis()
        console.log(
          "\tGot deposit address:",
          address,
          "; fund with:",
          lotSize.toString(),
          "satoshis please."
        )
        console.log("Now monitoring for deposit transaction...")
      } catch (err) {
        reject(err)
      }
    })

    deposit.onActive(async () => {
      try {
        if (mintOnActive) {
          // TODO Create a flow where output can be easily used to automate.
          console.log("Deposit is active, minting...")
          const mintedTbtc = await deposit.mintTBTC()

          resolve(
            standardDepositOutput(tbtc, deposit) + "\t" + mintedTbtc.toString()
          )
        } else {
          resolve(standardDepositOutput(tbtc, deposit))
        }
      } catch (err) {
        reject(err)
      }
    })
  })
}

/**
 * Executes a command to withdraw the ETH available to the current account from
 * the given deposit. If `onlyCall` is specified and passed as `true`, only
 * checks the available amount without sending a transaction to withdraw it.
 *
 * @param {TBTCInstance} tbtc
 * @param {string} depositAddress The address of
 * @param {boolean} [onlyCall]
 */
async function withdrawFromDeposit(tbtc, depositAddress, onlyCall) {
  const deposit = await tbtc.Deposit.withAddress(depositAddress)
  const method = deposit.contract.methods.withdrawFunds()

  if (onlyCall) {
    return await method.call()
  } else {
    return await EthereumHelpers.sendSafely(method, {
      from: tbtc.config.web3.eth.defaultAccount || undefined
    })
  }
}

/**
 * @param {TBTCInstance} tbtc
 * @param {string} depositAddress
 * @param {AVAILABLE_LIQUIDATION_REASONS} [liquidationReason]
 */
async function liquidateDeposit(tbtc, depositAddress, liquidationReason) {
  const deposit = await tbtc.Deposit.withAddress(depositAddress)
  const depositState = await deposit.getCurrentState()

  if (liquidationReason) {
    const { states, method } = LIQUIDATION_HANDLERS[liquidationReason]
    if (states.includes(depositState)) {
      await EthereumHelpers.sendSafely(deposit.contract.methods[method](), {
        from: tbtc.config.web3.eth.defaultAccount || undefined
      })
      return standardDepositOutput(tbtc, deposit)
    } else {
      throw new Error(
        `Deposit is not in a state that allows ${liquidationReason} liquidation.`
      )
    }
  } else {
    const depositStateName = tbtc.Deposit.stateById(depositState)
    const matchingHandler = Object.values(
      LIQUIDATION_HANDLERS
    ).find(({ states }) => states.includes(depositState))

    if (matchingHandler) {
      const { method } = matchingHandler
      console.debug(
        `Attempting to liquidate deposit based on state ${depositStateName} using ${method}.`
      )

      await EthereumHelpers.sendSafely(deposit.contract.methods[method](), {
        from: tbtc.config.web3.eth.defaultAccount || undefined
      })
      return standardDepositOutput(tbtc, deposit)
    } else {
      throw new Error(
        `Could not find a possible liquidation strategy for deposit state ${depositStateName}`
      )
    }
  }
}

// /**
//  * @param {string} str
//  * @return {BN?}
//  */
// function bnOrNull(str) {
//   try {
//     return web3.utils.toBN(str)
//   } catch (_) {
//     return null
//   }
// }
