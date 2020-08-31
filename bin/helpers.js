/**
 * @param {string[]} args
 * @param {string} arg
 * @return {{index: number, remaining: string[]}}
 */
export function findAndConsumeArg(args, arg) {
  const index = args.indexOf(arg)
  return {
    index,
    remaining: args.slice(0, index).concat(args.slice(index + 1))
  }
}

/**
 * @param {string[]} args
 * @param {string} arg
 * @return {{existence: boolean, remaining: string[]}}
 */
export function findAndConsumeArgExistence(args, arg) {
  const { index, remaining } = findAndConsumeArg(args, arg)
  return { existence: index != -1, remaining }
}

/** @typedef {{ [x: string]: boolean }} FoundArgsExistence */
/** @typedef {{ [x: string]: string|null }} FoundArgsValues */

/**
 * @param {string[]} args
 * @param {string[]} argsToCheck
 * @return {{found: FoundArgsExistence, remaining: string[]}}
 */
export function findAndConsumeArgsExistence(args, ...argsToCheck) {
  return argsToCheck.reduce(
    ({ found, remaining }, argToCheck) => {
      const {
        existence,
        remaining: postCheckArgs
      } = findAndConsumeArgExistence(remaining, argToCheck)
      return {
        found: Object.assign(found, { [camelCase(argToCheck)]: existence }),
        remaining: postCheckArgs
      }
    },
    { found: {}, remaining: args }
  )
}

/**
 * @param {string[]} args
 * @param {string} arg
 * @return {{value: string?, remaining: string[]}}
 */
export function findAndConsumeArgValue(args, arg) {
  const { index, remaining } = findAndConsumeArg(args, arg)
  const value = remaining[index]

  if (index == -1) {
    return { value: null, remaining }
  } else {
    return {
      value: value,
      remaining: remaining.slice(0, index).concat(args.slice(index + 1))
    }
  }
}

/**
 * @param {string[]} args
 * @param {string[]} argsToCheck
 * @return {{found: FoundArgsValues, remaining: string[]}}
 */
export function findAndConsumeArgsValues(args, ...argsToCheck) {
  return argsToCheck.reduce(
    ({ found, remaining }, argToCheck) => {
      const { value, remaining: postCheckArgs } = findAndConsumeArgValue(
        remaining,
        argToCheck
      )
      return {
        found: Object.assign(found, { [camelCase(argToCheck)]: value }),
        remaining: postCheckArgs
      }
    },
    { found: {}, remaining: args }
  )
}

/**
 * @param {string} argName The name of a command-line argument, typically as a
 *        --dashed-name.
 * @return {string} The argument name, which is typically a --dashed-name, as a
 *         camel-cased version (e.g. "dashedName").
 */
function camelCase(argName) {
  return argName
    .replace(/^-*/, "")
    .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}
