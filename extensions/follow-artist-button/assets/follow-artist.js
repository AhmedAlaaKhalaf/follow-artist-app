/**
 * Follow Artist button — storefront controller.
 *
 * The button only ever tells the backend which artist (type + handle) the page
 * is showing. The authenticated customer is determined server-side from the
 * signed App Proxy request, so nothing sensitive is exposed here.
 */
(function () {
  "use strict";

  var STATE = {
    LOGGED_OUT: "logged_out",
    NOT_FOLLOWING: "not_following",
    FOLLOWING: "following",
    LOADING: "loading",
  };

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
      loginUrl: root.getAttribute("data-login-url") || "/account/login",
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
      });
    }

    function mutate() {
      if (inFlight) return; // guard against duplicate clicks
      inFlight = true;
      setError(false);

      var wasFollowing = following;
      render(STATE.LOADING);

      var path = wasFollowing ? "/unfollow" : "/follow";
      request(path, {
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
        })
        .catch(function () {
          // Restore previous state and surface a friendly message.
          following = wasFollowing;
          render(following ? STATE.FOLLOWING : STATE.NOT_FOLLOWING);
          setError(true);
        })
        .then(function () {
          inFlight = false;
        });
    }

    // Wire up interactions.
    button.addEventListener("click", function () {
      if (!cfg.loggedIn) {
        window.location.href = cfg.loginUrl;
        return;
      }
      mutate();
    });

    // Initial render.
    if (!cfg.loggedIn) {
      render(STATE.LOGGED_OUT);
      return;
    }

    // Logged in: fetch current status; keep disabled until we know.
    render(STATE.LOADING);
    loadStatus().catch(function () {
      // If status fails, fall back to a usable "not following" state.
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

  // Re-init when the block is re-rendered in the theme editor.
  document.addEventListener("shopify:section:load", initAll);
  document.addEventListener("shopify:block:select", initAll);
})();
