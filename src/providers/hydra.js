/**
 * Provider for Auth0
 * @see https://www.ory.sh
 */
class SalteAuthHydraProvider {
  /**
   * Computes the deauthorization url
   * @param {Config} config configuration for salte auth
   * @return {String} the deauthorization url
   */
  static authorizeEndpoint(config) {
    return `${config.providerUrl}/oauth2/auth`;
  }

  static deauthorizeUrl(config) {
    return this.$utilities.createUrl(`${config.providerUrl}/oauth2/sessions/logout`, {
      returnTo: config.redirectUrl && config.redirectUrl.logoutUrl || config.redirectUrl,
      client_id: config.clientId
    });
  }
}

export default SalteAuthHydraProvider;
