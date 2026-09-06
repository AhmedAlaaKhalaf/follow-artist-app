/**
 * Follow Artist button — storefront controller.
 *
 * The button only ever tells the backend which artist (type + handle) the page
 * is showing. The authenticated customer is determined server-side from the
 * signed App Proxy request, so nothing sensitive is exposed here.
 *
 * Logged-out flow: save a pending follow intent → login → return here →
 * auto-follow so the button shows Following without a second click.
 */
(function () {
  "use strict";

  var STATE = {
    LOGGED_OUT: "logged_out",
    NOT_FOLLOWING: "not_following",
    FOLLOWING: "following",
    LOADING: "loading",
  };

  var PENDING_KEY = "artist-follow-pending";
  var FOLLOW_QUERY = "af_follow";

  function pendingKey(type, handle) {
    return String(type || "") + "::" + String(handle || "");
  }

  function savePending(type, handle) {
    try {
      sessionStorage.setItem(
        PENDING_KEY,
        JSON.stringify({
          type: type,
          handle: handle,
          key: pendingKey(type, handle),
          ts: Date.now(),
        }),
      );
    } catch (e) {
      // ignore quota / private mode
    }
  }

  function readPending() {
    try {
      var raw = sessionStorage.getItem(PENDING_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function clearPending() {
    try {
      sessionStorage.removeItem(PENDING_KEY);
    } catch (e) {
      // ignore
    }
  }

  function hasFollowQuery() {
    try {
      return new URLSearchParams(window.location.search).get(FOLLOW_QUERY) === "1";
    } catch (e) {
      return false;
    }
  }

  function stripFollowQuery() {
    try {
      var url = new URL(window.location.href);
      if (!url.searchParams.has(FOLLOW_QUERY)) return;
      url.searchParams.delete(FOLLOW_QUERY);
      var next = url.pathname + (url.search ? url.search : "") + url.hash;
      window.history.replaceState({}, "", next);
    } catch (e) {
      // ignore
    }
  }

  function notifyFollowChanged(detail) {
    try {
      document.dispatchEvent(
        new CustomEvent("artist-follow:changed", {
          detail: detail || {},
        }),
      );
    } catch (e) {
      // ignore
    }
  }

  function init(root) {
    if (root.__artistFollowReady) return;
    root.__artistFollowReady = true;

    var button = root.querySelector("[data-artist-follow-button]");
    var errorEl = root.querySelector("[data-artist-follow-error]");
    if (!button) return;

    var cfg = {
      proxyBase: (root.getAttribute("data-proxy-base") || "/apps/artist-follow").replace(/\/$/, ""),
      type: root.getAttribute("data-artist-type") || "",
      handle: root.getAttribute("data-artist-handle") || "",
      loggedIn: root.getAttribute("data-logged-in") === "true",
      loginUrl: root.getAttribute("data-login-url") || "/customer_authentication/login",
      returnTo: root.getAttribute("data-return-to") || "",
      labels: {
        follow: root.getAttribute("data-label-follow") || "Follow Artist",
        followCta: root.getAttribute("data-label-follow-cta") || "+ Follow Artist",
        following: root.getAttribute("data-label-following") || "\u2713 Following",
        followLoading: root.getAttribute("data-label-follow-loading") || "Following\u2026",
        unfollowLoading: root.getAttribute("data-label-unfollow-loading") || "Unfollowing\u2026",
        error: root.getAttribute("data-label-error") || "Something went wrong. Please try again.",
      },
    };

    var inFlight = false;
    var following = false;

    function setError(show) {
      if (!errorEl) return;
      if (show) {
        errorEl.textContent = cfg.labels.error;
        errorEl.hidden = false;
      } else {
        errorEl.textContent = "";
        errorEl.hidden = true;
      }
    }

    function render(state) {
      root.setAttribute("data-state", state);
      switch (state) {
        case STATE.LOGGED_OUT:
          button.textContent = cfg.labels.follow;
          button.disabled = false;
          button.classList.remove("is-following");
          break;
        case STATE.NOT_FOLLOWING:
          button.textContent = cfg.labels.followCta;
          button.disabled = false;
          button.classList.remove("is-following");
          break;
        case STATE.FOLLOWING:
          button.textContent = cfg.labels.following;
          button.disabled = false;
          button.classList.add("is-following");
          break;
        case STATE.LOADING:
          button.textContent = following
            ? cfg.labels.unfollowLoading
            : cfg.labels.followLoading;
          button.disabled = true;
          break;
      }
    }

    function request(path, options) {
      return fetch(cfg.proxyBase + path, options).then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            if (!res.ok) {
              var err = new Error(body && body.error ? body.error : "request_failed");
              err.status = res.status;
              throw err;
            }
            return body;
          });
      });
    }

    function loadStatus() {
      var qs =
        "?type=" + encodeURIComponent(cfg.type) + "&handle=" + encodeURIComponent(cfg.handle);
      return request("/status" + qs, {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      }).then(function (body) {
        following = Boolean(body.following);
        render(following ? STATE.FOLLOWING : STATE.NOT_FOLLOWING);
        return body;
      });
    }

    function mutate(forceFollow) {
      if (inFlight) return Promise.resolve();
      inFlight = true;
      setError(false);

      var wasFollowing = following;
      var shouldFollow = forceFollow ? true : !wasFollowing;
      render(STATE.LOADING);

      var path = shouldFollow ? "/follow" : "/unfollow";
      return request(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({ type: cfg.type, handle: cfg.handle }),
      })
        .then(function (body) {
          following = Boolean(body.following);
          render(following ? STATE.FOLLOWING : STATE.NOT_FOLLOWING);
          notifyFollowChanged({
            type: cfg.type,
            handle: cfg.handle,
            following: following,
          });
          return body;
        })
        .catch(function () {
          following = wasFollowing;
          render(following ? STATE.FOLLOWING : STATE.NOT_FOLLOWING);
          setError(true);
        })
        .then(function (body) {
          inFlight = false;
          return body;
        });
    }

    function shouldAutoFollow() {
      var pending = readPending();
      var key = pendingKey(cfg.type, cfg.handle);
      var fromStorage = pending && pending.key === key;
      var fromQuery = hasFollowQuery();
      return Boolean(fromStorage || fromQuery);
    }

    function buildLoginReturnTo() {
      var returnTo =
        cfg.returnTo ||
        window.location.pathname + window.location.search ||
        "/";
      if (returnTo.charAt(0) !== "/") {
        returnTo = "/" + returnTo;
      }
      // Mark intent in the return URL as a backup to sessionStorage.
      try {
        var u = new URL(returnTo, window.location.origin);
        u.searchParams.set(FOLLOW_QUERY, "1");
        return u.pathname + (u.search ? u.search : "");
      } catch (e) {
        var join = returnTo.indexOf("?") >= 0 ? "&" : "?";
        return returnTo + join + FOLLOW_QUERY + "=1";
      }
    }

    // Wire up interactions.
    button.addEventListener("click", function () {
      if (!cfg.loggedIn) {
        // Persist follow intent across New Customer Accounts login.
        savePending(cfg.type, cfg.handle);
        window.location.href =
          "/customer_authentication/login?return_to=" +
          encodeURIComponent(buildLoginReturnTo());
        return;
      }
      mutate(false);
    });

    // Initial render.
    if (!cfg.loggedIn) {
      render(STATE.LOGGED_OUT);
      return;
    }

    // Logged in: if they clicked Follow before login, auto-follow now.
    render(STATE.LOADING);
    if (shouldAutoFollow()) {
      clearPending();
      stripFollowQuery();
      mutate(true).catch(function () {
        // Fall back to status if auto-follow fails.
        return loadStatus().catch(function () {
          following = false;
          render(STATE.NOT_FOLLOWING);
          setError(true);
        });
      });
      return;
    }

    stripFollowQuery();
    loadStatus().catch(function () {
      following = false;
      render(STATE.NOT_FOLLOWING);
      setError(true);
    });
  }

  function initAll() {
    var roots = document.querySelectorAll("[data-artist-follow]");
    for (var i = 0; i < roots.length; i++) {
      init(roots[i]);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }

  document.addEventListener("shopify:section:load", initAll);
  document.addEventListener("shopify:block:select", initAll);
})();
