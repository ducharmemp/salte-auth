import assign from 'lodash/assign';
import defaultsDeep from 'lodash/defaultsDeep';
import get from 'lodash/get';
import set from 'lodash/set';
import uuid from 'uuid';
import debug from 'debug';

import { Providers } from './salte-auth.providers.js';
import { SalteAuthProfile } from './salte-auth.profile.js';
import { SalteAuthUtilities } from './salte-auth.utilities.js';
import { SalteAuthMixinGenerator } from './salte-auth.mixin.js';

/** @ignore */
const logger = debug('@salte-auth/salte-auth');

/**
 * Disable certain security validations if your provider doesn't support them.
 * @typedef {Object} Validation
 * @property {Boolean} [nonce=true] Passing false will disable nonce validation, leaving you vulnerable to replay attacks.
 * @property {Boolean} [state=true] Passing false will disable state validation, leaving you vulnerable to XSRF attacks.
 * @property {Boolean} [azp=true] Passing false will disable azp validation.
 * @property {Boolean} [aud=true] Passing false will disable aud validation.
 */

/**
 * Disable certain security validations if your provider doesn't support them.
 * @typedef {Object} RedirectURLs
 * @property {String} [loginUrl] The redirect url specified in your identity provider for logging in.
 * @property {String} [logoutUrl] The redirect url specified in your identity provider for logging out.
 */

/**
 * The configuration for salte auth
 * @typedef {Object} Config
 * @property {String} providerUrl The base url of your identity provider.
 * @property {('id_token'|'id_token token'|'code')} responseType The response type to authenticate with.
 * @property {String|RedirectURLs} redirectUrl The redirect url specified in your identity provider.
 * @property {String} clientId The client id of your identity provider
 * @property {String} scope A list of space-delimited claims used to determine what user information is provided and what access is given. Most providers require 'openid'.
 * @property {Boolean|Array<String>} routes A list of secured routes. If true is provided then all routes are secured.
 * @property {Array<String|RegExp>} endpoints A list of secured endpoints.
 * @property {('auth0'|'azure'|'cognito'|'wso2'|'okta')} provider The identity provider you're using.
 * @property {('iframe'|'redirect'|false)} [loginType='iframe'] The automated login type to use.
 * @property {Function} [redirectLoginCallback] A callback that is invoked when a redirect login fails or succeeds.
 * @property {('session'|'local')} [storageType='session'] The Storage api to keep authenticate information stored in.
 * @property {Boolean|Validation} [validation] Used to disable certain security validations if your provider doesn't support them.
 * @property {Boolean} [autoRefresh=true] Automatically refreshes the users token upon switching tabs or one minute prior to expiration.
 * @property {Number} [autoRefreshBuffer=60000] A number of miliseconds before token expiration to refresh.
 * @property {Object} [queryParams] A key-value set of additional query params to attached to the login request.
 */

/**
 * The configuration for salte auth
 * @typedef {Object} LoginConfig
 * @property {Boolean} [noPrompt=false] Disables login prompts, this should only be used for token renewal!
 * @property {(false|'errors'|'all')} [clear='all'] Whether to clear "all" profile information, only "errors", or nothing.
 * @property {Boolean} [events=true] Whether events should be fired off if the login is successful or not.
 */

/**
 * Authentication Controller
 */
class SalteAuth {
  /**
   * Sets up Salte Auth
   * @param {Config} config configuration for salte auth
   */
  constructor(config) {
    if (window.salte.auth) {
      return window.salte.auth;
    }

    if (!config) {
      throw new ReferenceError('A config must be provided.');
    }

    /**
     * The supported identity providers
     * @type {Providers}
     * @private
     */
    this.$providers = Providers;
    /**
     * The active authentication promises
     * @private
     */
    this.$promises = {};
    /**
     * The active authentication timeouts
     * @private
     */
    this.$timeouts = {};
    /**
     * The registered listeners
     * @private
     */
    this.$listeners = {};
    /**
     * The configuration for salte auth
     * @type {Config}
     * @private
     */
    this.$config = config;
    this.$config = defaultsDeep(config, this.$provider.defaultConfig, {
      loginType: 'iframe',
      autoRefresh: true,
      autoRefreshBuffer: 60000
    });
    /**
     * Various utility functions for salte auth
     * @type {SalteAuthUtilities}
     * @private
     */
    this.$utilities = new SalteAuthUtilities(this.$config);

    /**
     * The user profile for salte auth
     * @type {SalteAuthProfile}
     */
    this.profile = new SalteAuthProfile(this.$config);

    /**
     * A mixin built for Web Components
     *
     * @example
     * class MyElement extends auth.mixin(HTMLElement) {
     *   constructor() {
     *     super();
     *
     *     console.log(this.auth); // This is the same as auth
     *     console.log(this.user); // This is the same as auth.profile.userInfo.
     *     console.log(this.authenticated); // This is the same as auth.profile.idTokenExpired.
     *   }
     * }
     */
    this.mixin = SalteAuthMixinGenerator(this);

    if (this.$utilities.$iframe) {
      logger('Detected iframe, removing...');
      this.profile.$parseParams();
      parent.document.body.removeChild(this.$utilities.$iframe);
    } else if (this.$utilities.$popup) {
      logger('Popup detected!');
    } else if (this.profile.$redirectUrl && location.href !== this.profile.$redirectUrl) {
      logger('Redirect detected!');
      this.profile.$parseParams();
      const error = this.profile.$validate();

      // Delay for an event loop to give users time to register a listener.
      setTimeout(() => {
        const action = this.profile.$actions(this.profile.$state);

        if (error) {
          this.profile.$clear();
        } else {
          logger(`Navigating to Redirect URL... (${this.profile.$redirectUrl})`);
          this.$utilities.$navigate(this.profile.$redirectUrl);
          this.profile.$redirectUrl = undefined;
        }

        if (action === 'login') {
          this.$fire('login', error || null, this.profile.code || this.profile.userInfo);
        } else if (action === 'logout') {
          this.$fire('logout', error);
        }

        // TODO(v3.0.0): Remove the `redirectLoginCallback` api from `salte-auth`.
        this.$config.redirectLoginCallback && this.$config.redirectLoginCallback(error);
      });
    } else {
      logger('Setting up interceptors...');
      this.$utilities.addXHRInterceptor((request, data) => {
        if (this.$config.responseType !== 'code' && this.$utilities.checkForMatchingUrl(request.$url, this.$config.endpoints)) {
          return this.retrieveAccessToken().then((accessToken) => {
            request.setRequestHeader('Authorization', `Bearer ${accessToken}`);
          });
        }
      });

      this.$utilities.addFetchInterceptor((request) => {
        if (this.$config.responseType !== 'code' && this.$utilities.checkForMatchingUrl(request.url, this.$config.endpoints)) {
          return this.retrieveAccessToken().then((accessToken) => {
            request.headers.set('Authorization', `Bearer ${accessToken}`);
          });
        }
      });

      logger('Setting up route change detectors...');
      window.addEventListener('popstate', this.$$onRouteChanged.bind(this), { passive: true });
      document.addEventListener('click', this.$$onRouteChanged.bind(this), { passive: true });
      setTimeout(this.$$onRouteChanged.bind(this));

      logger('Setting up automatic renewal of token...');
      this.on('login', (error) => {
        if (error) return;

        this.$$refreshToken();
      });

      this.on('refresh', (error) => {
        if (error) return;

        this.$$refreshToken();
      });

      this.on('logout', () => {
        clearTimeout(this.$timeouts.refresh);
      });

      if (!this.profile.idTokenExpired) {
        this.$$refreshToken();
      }

      document.addEventListener('visibilitychange', this.$$onVisibilityChanged.bind(this), {
        passive: true
      });

      this.$fire('create', null, this);
    }

    // TODO(v3.0.0): Revoke singleton status from `salte-auth`.
    window.salte.auth = this;

    if (this.$config.redirectLoginCallback) {
      console.warn(`The "redirectLoginCallback" api has been deprecated in favor of the "on" api, see http://bit.ly/salte-auth-on for more info.`);
    }
  }

  /**
   * Returns the configured provider
   * @type {Class|Object}
   * @private
   */
  get $provider() {
    if (!this.$config.provider) {
      throw new ReferenceError('A provider must be specified');
    }

    if (typeof this.$config.provider === 'string') {
      const provider = this.$providers[this.$config.provider];
      if (!provider) {
        throw new ReferenceError(`Unknown Provider (${this.$config.provider})`);
      }
      return provider;
    }

    return this.$config.provider;
  }

  /**
   * The authentication url to retrieve the access token
   * @type {String}
   * @private
   */
  get $accessTokenUrl() {
    this.profile.$localState = uuid.v4();
    this.profile.$nonce = uuid.v4();

    let authorizeEndpoint = `${this.$config.providerUrl}/authorize`;
    if (this.$provider.authorizeEndpoint) {
      authorizeEndpoint = this.$provider.authorizeEndpoint.call(this, this.$config);
    }

    return this.$utilities.createUrl(authorizeEndpoint, assign({
      'state': this.profile.$localState,
      'nonce': this.profile.$nonce,
      'response_type': 'token',
      'redirect_uri': this.$config.redirectUrl && this.$config.redirectUrl.loginUrl || this.$config.redirectUrl,
      'client_id': this.$config.clientId,
      'scope': this.$config.scope,
      'prompt': 'none'
    }, this.$config.queryParams));
  }

  /**
   * The authentication url to retrieve the id token
   * @param {Boolean} refresh Whether this request is intended to refresh the token.
   * @return {String} the computed login url
   * @private
   */
  $loginUrl(refresh) {
    this.profile.$localState = uuid.v4();
    this.profile.$nonce = uuid.v4();

    let authorizeEndpoint = `${this.$config.providerUrl}/authorize`;
    if (this.$provider.authorizeEndpoint) {
      authorizeEndpoint = this.$provider.authorizeEndpoint.call(this, this.$config);
    }

    return this.$utilities.createUrl(authorizeEndpoint, assign({
      'state': this.profile.$localState,
      'nonce': this.profile.$nonce,
      'response_type': this.$config.responseType,
      'redirect_uri': this.$config.redirectUrl && this.$config.redirectUrl.loginUrl || this.$config.redirectUrl,
      'client_id': this.$config.clientId,
      'scope': this.$config.scope,
      'prompt': refresh ? 'none' : undefined
    }, this.$config.queryParams));
  }

  /**
   * The url to logout of the configured provider
   * @type {String}
   * @private
   */
  get $deauthorizeUrl() {
    return this.$provider.deauthorizeUrl.call(this, defaultsDeep(this.$config, {
      idToken: this.profile.$idToken
    }));
  }

  /**
   * Listens for an event to be invoked.
   * @param {('login'|'logout'|'refresh'|'expired')} eventType the event to listen for.
   * @param {Function} callback A callback that fires when the specified event occurs.
   *
   * @example
   * auth.on('login', (error, user) => {
   *   if (error) {
   *     console.log('something bad happened!');
   *   }
   *
   *   console.log(user); // This is the same as auth.profile.userInfo.
   * });
   *
   * @example
   * window.addEventListener('salte-auth-login', (event) => {
   *   if (event.detail.error) {
   *     console.log('something bad happened!');
   *   }
   *
   *   console.log(event.detail.data); // This is the same as auth.profile.userInfo.
   * });
   */
  on(eventType, callback) {
    if (['login', 'logout', 'refresh', 'expired'].indexOf(eventType) === -1) {
      throw new ReferenceError(`Unknown Event Type (${eventType})`);
    } else if (typeof callback !== 'function') {
      throw new ReferenceError('Invalid callback provided!');
    }

    this.$listeners[eventType] = this.$listeners[eventType] || [];
    this.$listeners[eventType].push(callback);
  }

  /**
   * Deregister a callback previously registered.
   * @param {('login'|'logout'|'refresh'|'expired')} eventType the event to deregister.
   * @param {Function} callback A callback that fires when the specified event occurs.
   *
   * @example
   * const someFunction = function() {};
   *
   * auth.on('login', someFunction);
   *
   * auth.off('login', someFunction);
   */
  off(eventType, callback) {
    if (['login', 'logout', 'refresh', 'expired'].indexOf(eventType) === -1) {
      throw new ReferenceError(`Unknown Event Type (${eventType})`);
    } else if (typeof callback !== 'function') {
      throw new ReferenceError('Invalid callback provided!');
    }

    const eventListeners = this.$listeners[eventType];
    if (!eventListeners || !eventListeners.length) return;

    const index = eventListeners.indexOf(callback);
    eventListeners.splice(index, 1);
  }

  /**
   * Fires off an event to a given set of listeners
   * @param {String} eventType The event that occurred.
   * @param {Error} error The error tied to this event.
   * @param {*} data The data tied to this event.
   * @private
   */
  $fire(eventType, error, data) {
    const event = document.createEvent('Event');
    event.initEvent(`salte-auth-${eventType}`, false, true);
    event.detail = { error, data };
    window.dispatchEvent(event);

    const eventListeners = this.$listeners[eventType];

    if (!eventListeners || !eventListeners.length) return;

    eventListeners.forEach((listener) => listener(error, data));
  }

  /**
   * Authenticates using the iframe-based OAuth flow.
   * @param {Boolean|LoginConfig} config Whether this request is intended to refresh the token.
   * @return {Promise<Object>} a promise that resolves when we finish authenticating
   *
   * @example
   * auth.loginWithIframe().then((user) => {
   *   console.log(user); // This is the same as auth.profile.userInfo.
   * }).catch((error) => {
   *   console.error('Whoops something went wrong!', error);
   * });
   */
  loginWithIframe(config) {
    if (this.$promises.login) {
      return this.$promises.login;
    }

    // TODO(v3.0.0): Remove backwards compatibility with refresh boolean.
    if (typeof config === 'boolean') {
      config = {
        noPrompt: config,
        clear: config ? 'errors' : undefined,
        events: false,
        timeout: 3000
      };
    }

    config = defaultsDeep(config, {
      noPrompt: false,
      clear: 'all',
      events: true
    });

    if (config.clear === 'all') {
      this.profile.$clear();
    } else if (config.clear === 'errors') {
      this.profile.$clearErrors();
    }

    this.$promises.login = this.$utilities.createIframe(this.$loginUrl(config.noPrompt), !config.noPrompt, config.timeout).then(() => {
      this.$promises.login = null;
      const error = this.profile.$validate();

      if (error) {
        return Promise.reject(error);
      }

      const response = this.profile.code || this.profile.userInfo;
      if (config.events) {
        this.$fire('login', null, response);
      }
      return response;
    }).catch((error) => {
      this.$promises.login = null;
      if (config.events) {
        this.$fire('login', error);
      }
      return Promise.reject(error);
    });

    return this.$promises.login;
  }

  /**
   * Authenticates using the popup-based OAuth flow.
   * @return {Promise<Object>} a promise that resolves when we finish authenticating
   *
   * @example
   * auth.loginWithPopup().then((user) => {
   *   console.log(user); // This is the same as auth.profile.userInfo.
   * }).catch((error) => {
   *   console.error('Whoops something went wrong!', error);
   * });
   */
  loginWithPopup() {
    if (this.$promises.login) {
      return this.$promises.login;
    }

    this.profile.$clear();
    this.$promises.login = this.$utilities.openPopup(this.$loginUrl()).then(() => {
      this.$promises.login = null;
      this.profile.$parseParams();
      const error = this.profile.$validate();

      if (error) {
        this.profile.$clear();
        return Promise.reject(error);
      }

      const response = this.profile.code || this.profile.userInfo;
      this.$fire('login', null, response);
      return response;
    }).catch((error) => {
      this.$promises.login = null;
      this.$fire('login', error);
      return Promise.reject(error);
    });

    return this.$promises.login;
  }

  /**
   * Authenticates using the tab-based OAuth flow.
   * @return {Promise<Object>} a promise that resolves when we finish authenticating
   *
   * @example
   * auth.loginWithNewTab().then((user) => {
   *   console.log(user); // This is the same as auth.profile.userInfo.
   * }).catch((error) => {
   *   console.error('Whoops something went wrong!', error);
   * });
   */
  loginWithNewTab() {
    if (this.$promises.login) {
      return this.$promises.login;
    }

    this.profile.$clear();
    this.$promises.login = this.$utilities.openNewTab(this.$loginUrl()).then(() => {
      this.$promises.login = null;
      this.profile.$parseParams();
      const error = this.profile.$validate();

      if (error) {
        this.profile.$clear();
        return Promise.reject(error);
      }

      const response = this.profile.code || this.profile.userInfo;
      this.$fire('login', null, response);
      return response;
    }).catch((error) => {
      this.$promises.login = null;
      this.$fire('login', error);
      return Promise.reject(error);
    });

    return this.$promises.login;
  }

  /**
   * Authenticates using the redirect-based OAuth flow.
   * @param {String} redirectUrl override for the redirect url, by default this will try to redirect the user back where they started.
   * @return {Promise} a promise intended to block future login attempts.
   *
   * @example
   * auth.loginWithRedirect(); // Don't bother with utilizing the promise here, it never resolves.
   */
  loginWithRedirect(redirectUrl) {
    if (this.$config.redirectLoginCallback) {
      console.warn(`The "redirectLoginCallback" api has been deprecated in favor of the "on" api, see http://bit.ly/salte-auth-on for more info.`);
    }

    if (this.$promises.login) {
      return this.$promises.login;
    }

    // NOTE: This prevents the other login types from racing "loginWithRedirect".
    // Without this someone could potentially call login somewhere else before
    // the app has a change to redirect. Which could result in an invalid state.
    this.$promises.login = new Promise(() => {});

    this.profile.$clear();
    this.profile.$redirectUrl = redirectUrl && this.$utilities.resolveUrl(redirectUrl) || this.profile.$redirectUrl || location.href;
    const url = this.$loginUrl();

    this.profile.$actions(this.profile.$localState, 'login');
    this.$utilities.$navigate(url);

    return this.$promises.login;
  }

  /**
   * Unauthenticates using the iframe-based OAuth flow.
   * @return {Promise} a promise that resolves when we finish deauthenticating
   *
   * @example
   * auth.logoutWithIframe().then(() => {
   *   console.log('success!');
   * }).catch((error) => {
   *   console.error('Whoops something went wrong!', error);
   * });
   */
  logoutWithIframe() {
    if (this.$promises.logout) {
      return this.$promises.logout;
    }

    const deauthorizeUrl = this.$deauthorizeUrl;
    this.profile.$clear();

    this.$promises.logout = this.$utilities.createIframe(deauthorizeUrl).then(() => {
      this.$promises.logout = null;
      this.$fire('logout');
    }).catch((error) => {
      this.$promises.logout = null;
      this.$fire('logout', error);
      return Promise.reject(error);
    });
    return this.$promises.logout;
  }

  /**
   * Unauthenticates using the popup-based OAuth flow.
   * @return {Promise} a promise that resolves when we finish deauthenticating
   *
   * @example
   * auth.logoutWithPopup().then(() => {
   *   console.log('success!');
   * }).catch((error) => {
   *   console.error('Whoops something went wrong!', error);
   * });
   */
  logoutWithPopup() {
    if (this.$promises.logout) {
      return this.$promises.logout;
    }

    const deauthorizeUrl = this.$deauthorizeUrl;
    this.profile.$clear();

    this.$promises.logout = this.$utilities.openPopup(deauthorizeUrl).then(() => {
      this.$promises.logout = null;
      this.$fire('logout');
    }).catch((error) => {
      this.$promises.logout = null;
      this.$fire('logout', error);
      return Promise.reject(error);
    });

    return this.$promises.logout;
  }

  /**
   * Unauthenticates using the tab-based OAuth flow.
   * @return {Promise} a promise that resolves when we finish deauthenticating
   *
   * @example
   * auth.logoutWithNewTab().then(() => {
   *   console.log('success!');
   * }).catch((error) => {
   *   console.error('Whoops something went wrong!', error);
   * });
   */
  logoutWithNewTab() {
    if (this.$promises.logout) {
      return this.$promises.logout;
    }

    const deauthorizeUrl = this.$deauthorizeUrl;
    this.profile.$clear();

    this.$promises.logout = this.$utilities.openNewTab(deauthorizeUrl).then(() => {
      this.$promises.logout = null;
      this.$fire('logout');
    }).catch((error) => {
      this.$promises.logout = null;
      this.$fire('logout', error);
      return Promise.reject(error);
    });

    return this.$promises.logout;
  }

  /**
   * Logs the user out of their configured identity provider.
   *
   * @example
   * auth.logoutWithRedirect();
   */
  logoutWithRedirect() {
    const deauthorizeUrl = this.$deauthorizeUrl;
    this.profile.$clear();

    this.profile.$actions(this.profile.$localState, 'logout');
    this.$utilities.$navigate(deauthorizeUrl);
  }

  /**
   * Refreshes the users tokens and renews their session.
   * @return {Promise} a promise that resolves when we finish renewing the users tokens.
   */
  refreshToken() {
    if (this.$promises.refresh) {
      return this.$promises.refresh;
    }

    this.$promises.refresh = this.loginWithIframe(true).then((user) => {
      this.$promises.refresh = null;
      const error = this.profile.$validate(true);

      if (error) {
        return Promise.reject(error);
      }
      this.$promises.refresh = null;
      this.$fire('refresh', null, user);
      return user;
    }).catch((error) => {
      this.$promises.refresh = null;
      this.$fire('refresh', error);
      return Promise.reject(error);
    });

    return this.$promises.refresh;
  }
  /**
   * Registers a timeout that will automatically refresh the id token
   */
  $$refreshToken() {
    if (this.$timeouts.refresh !== undefined) {
      clearTimeout(this.$timeouts.refresh);
    }

    if (this.$timeouts.expired !== undefined) {
      clearTimeout(this.$timeouts.expired);
    }

    const timeToExpiration = (this.profile.userInfo.exp * 1000) - Date.now();

    this.$timeouts.refresh = setTimeout(() => {
      // Allows Auto Refresh to be disabled
      if (this.$config.autoRefresh) {
        this.refreshToken().catch((error) => {
          console.error(error);
        });
      } else {
        this.$fire('refresh');
      }
    }, Math.max(timeToExpiration - this.$config.autoRefreshBuffer, 0));

    this.$timeouts.expired = setTimeout(() => {
      this.$fire('expired');
    }, Math.max(timeToExpiration, 0));
  }

  /**
   * Authenticates, requests the access token, and returns it if necessary.
   * @return {Promise<string>} a promise that resolves when we retrieve the access token
   */
  retrieveAccessToken() {
    if (this.$promises.token) {
      logger('Existing token request detected, resolving...');
      return this.$promises.token;
    }

    this.$promises.token = Promise.resolve();
    if ((this.$config.responseType === 'code' && !this.profile.code) || (this.$config.responseType !== 'code' && this.profile.idTokenExpired)) {
      logger('id token has expired, reauthenticating...');
      if (this.$config.loginType === 'iframe') {
        logger('Initiating the iframe flow...');
        this.$promises.token = this.loginWithIframe();
      } else if (this.$config.loginType === 'redirect') {
        this.$promises.token = this.loginWithRedirect();
      } else if (this.$config.loginType === false) {
        if (this.$promises.login) {
          this.$promises.token = this.$promises.login;
        } else {
          this.$promises.token = null;
          return Promise.reject(new ReferenceError('Automatic login is disabled, please login before making any requests!'));
        }
      } else {
        this.$promises.token = null;
        return Promise.reject(new ReferenceError(`Invalid Login Type (${this.$config.loginType})`));
      }
    }

    if (this.$config.responseType !== 'code') {
      this.$promises.token = this.$promises.token.then(() => {
        this.profile.$clearErrors();
        if (this.profile.accessTokenExpired) {
          logger('Access token has expired, renewing...');
          return this.$utilities.createIframe(this.$accessTokenUrl).then(() => {
            const error = this.profile.$validate(true);

            if (error) {
              return Promise.reject(error);
            }
            return this.profile.$accessToken;
          });
        }
        return this.profile.$accessToken;
      });
    }

    if (this.$promises.token) {
      this.$promises.token = this.$promises.token.then((response) => {
        this.$promises.token = null;
        return response;
      }).catch((error) => {
        this.$promises.token = null;
        return Promise.reject(error);
      });
    }

    return this.$promises.token;
  }

  /**
   * Checks if the current route is secured and authenticates the user if necessary
   * @ignore
   */
  $$onRouteChanged() {
    logger('Route change detected, determining if the route is secured...');
    if (!this.$utilities.isRouteSecure(location.href, this.$config.routes)) return;

    logger('Route is secure, verifying tokens...');
    this.retrieveAccessToken();
  }

  /**
   * Disables automatic refresh of the token if the page is no longer visible
   * @ignore
   */
  $$onVisibilityChanged() {
    logger('Visibility change detected, deferring to the next event loop...');
    logger('Determining if the id token has expired...');
    if (this.profile.idTokenExpired || !this.$config.autoRefresh) return;

    if (this.$utilities.$hidden) {
      logger('Page is hidden, refreshing the token...');
      this.refreshToken().then(() => {
        logger('Disabling automatic renewal of the token...');
        clearTimeout(this.$timeouts.refresh);
        this.$timeouts.refresh = null;
      });
    } else {
      logger('Page is visible restarting automatic token renewal...');
      this.$$refreshToken();
    }
  }
}

set(window, 'salte.SalteAuth', get(window, 'salte.SalteAuth', SalteAuth));
export { SalteAuth };
export default SalteAuth;
