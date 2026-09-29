export class RequestFailedError extends Error {}
export class ConnectTimeoutError extends Error {}
export class CustomHttpAgent {}
export class CustomHttpsAgent {}

export async function fetchJson(...args) {
  if (fetchJson.impl) return fetchJson.impl(...args)
  return {}
}
export async function fetchJsonWithResponse(...args) {
  if (fetchJsonWithResponse.impl) return fetchJsonWithResponse.impl(...args)
  return { json: {}, response: {} }
}
export async function fetchStream(...args) {
  if (fetchStream.impl) return fetchStream.impl(...args)
  return {}
}
export async function fetchStreamWithResponse(...args) {
  if (fetchStreamWithResponse.impl) return fetchStreamWithResponse.impl(...args)
  return { stream: {}, response: {} }
}
export async function fetchNothing(...args) {
  if (fetchNothing.impl) return fetchNothing.impl(...args)
  return {}
}
export async function fetchRedirect(...args) {
  if (fetchRedirect.impl) return fetchRedirect.impl(...args)
  return {}
}
export async function fetchRedirectWithResponse(...args) {
  if (fetchRedirectWithResponse.impl) return fetchRedirectWithResponse.impl(...args)
  return { response: {} }
}
export async function fetchString(...args) {
  if (fetchString.impl) return fetchString.impl(...args)
  return ''
}
export async function fetchStringWithResponse(...args) {
  if (fetchStringWithResponse.impl) return fetchStringWithResponse.impl(...args)
  return { string: '', response: {} }
}
export function setLogger() {}

export default {
  fetchJson,
  fetchJsonWithResponse,
  fetchStream,
  fetchStreamWithResponse,
  fetchNothing,
  fetchRedirect,
  fetchRedirectWithResponse,
  fetchString,
  fetchStringWithResponse,
  RequestFailedError,
  ConnectTimeoutError,
  CustomHttpAgent,
  CustomHttpsAgent,
  setLogger,
}
