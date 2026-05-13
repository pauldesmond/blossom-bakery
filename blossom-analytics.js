/*
 * Blossom Bakery — analytics + cookie consent.
 *
 * GA4 with consent mode v2: analytics_storage defaults to 'denied' so the
 * gtag.js loader is harmless until Helen's visitor clicks Accept. A simple
 * banner shows on first visit only (decision is stored in localStorage).
 *
 * To go live, replace the placeholder measurement ID below with the GA4
 * property's ID (looks like G-ABCD1234EF).
 */
(function () {
  'use strict';
  var GA_MEASUREMENT_ID = 'G-XXXXXXXXXX'; // TODO: replace with real GA4 ID
  var STORAGE_KEY = 'blossom-cookie-consent';
  var d = document;

  // Consent Mode v2 defaults — set before any GA call.
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('consent', 'default', {
    ad_storage: 'denied',
    analytics_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    wait_for_update: 500,
  });
  gtag('js', new Date());
  gtag('config', GA_MEASUREMENT_ID, { anonymize_ip: true });

  function loadGtagScript() {
    if (d.getElementById('ga4-loader')) return;
    var s = d.createElement('script');
    s.async = true;
    s.id = 'ga4-loader';
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_MEASUREMENT_ID;
    d.head.appendChild(s);
  }

  function applyConsent(granted) {
    gtag('consent', 'update', {
      analytics_storage: granted ? 'granted' : 'denied',
    });
    if (granted) loadGtagScript();
  }

  function dismissBanner() {
    var el = d.getElementById('cookie-banner');
    if (el) el.remove();
  }

  function setStored(value) {
    try { localStorage.setItem(STORAGE_KEY, value); } catch (e) {}
  }

  function getStored() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }

  function renderBanner() {
    var stored = getStored();
    if (stored === 'accepted') { applyConsent(true); return; }
    if (stored === 'rejected') { applyConsent(false); return; }

    var banner = d.createElement('div');
    banner.id = 'cookie-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-live', 'polite');
    banner.setAttribute('aria-label', 'Cookie preferences');
    banner.innerHTML =
      '<p class="cookie-banner__text">We use cookies to understand how visitors use the site. See our <a href="/privacy.html">privacy policy</a>.</p>' +
      '<div class="cookie-banner__actions">' +
      '  <button type="button" class="cookie-banner__btn cookie-banner__btn--reject">Reject</button>' +
      '  <button type="button" class="cookie-banner__btn cookie-banner__btn--accept">Accept</button>' +
      '</div>';
    d.body.appendChild(banner);

    banner.querySelector('.cookie-banner__btn--accept').addEventListener('click', function () {
      setStored('accepted');
      applyConsent(true);
      dismissBanner();
    });
    banner.querySelector('.cookie-banner__btn--reject').addEventListener('click', function () {
      setStored('rejected');
      applyConsent(false);
      dismissBanner();
    });
  }

  if (d.readyState === 'loading') {
    d.addEventListener('DOMContentLoaded', renderBanner);
  } else {
    renderBanner();
  }
})();
