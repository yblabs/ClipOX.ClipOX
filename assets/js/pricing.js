/* ==========================================================================
   PRICING — Framewright
   Page behaviour: the billing switch and the credit estimator.
   (Navigation, reveals, counters, dock and back-to-top all come from
   framecraft.js, which is shared with index.html.)
   No dependencies; runs as a classic script at the end of <body>.
   ========================================================================== */
(function () {
  'use strict';

  var $  = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var cycle = 'monthly';          // shared billing state

  /* ------------------------------------------------------- billing switch */
  var toggle = $('#billingToggle');
  var hint   = $('#toggleHint');

  function applyCycle() {
    // swap every element that carries both variants
    $$('[data-monthly][data-annual]').forEach(function (el) {
      el.textContent = cycle === 'annual' ? el.getAttribute('data-annual')
                                          : el.getAttribute('data-monthly');
    });

    if (toggle) {
      toggle.classList.toggle('annual', cycle === 'annual');
      var opts = $$('.bt-opt', toggle);
      opts.forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-cycle') === cycle);
      });
      var pill = $('.bt-pill', toggle);
      var active = opts.filter(function (b) { return b.getAttribute('data-cycle') === cycle; })[0];
      if (pill && active) {
        // Measure from the untransformed plate so the container's own border
        // and padding can never skew the alignment, then slide it across.
        pill.style.transform = 'none';
        var shift = active.getBoundingClientRect().left - pill.getBoundingClientRect().left;
        pill.style.width = active.offsetWidth + 'px';
        pill.style.transform = 'translateX(' + shift + 'px)';
      }
    }

    if (hint) {
      hint.textContent = cycle === 'annual'
        ? 'Annual billing is not required — the Free plan is $0 forever.'
        : 'Every tool is included on the Free plan — $0 forever, no card required.';
    }

    if (typeof renderEstimator === 'function') renderEstimator();
    document.dispatchEvent(new CustomEvent('cyclechange', { detail: { cycle: cycle } }));
  }

  if (toggle) {
    $$('.bt-opt', toggle).forEach(function (btn) {
      btn.addEventListener('click', function () {
        cycle = btn.getAttribute('data-cycle');
        applyCycle();
      });
    });
  }

  /* ---------------------------------------------------------- estimator */
  var range = $('#minutesRange');
  var renderEstimator = null;

  if (range) {
    renderEstimator = function () {
      var minutes = parseInt(range.value, 10);
      var isAnnual = cycle === 'annual';

      // Only the Free seat ships right now — paid tiers are off the page.
      var plans = [
        { name: 'Free', cap: Infinity, price: 0, cta: 'Get started with Free' }
      ];
      var pick = plans.filter(function (p) { return minutes <= p.cap; })[0] ||
                 plans[plans.length - 1];

      // fill the slider track up to the thumb
      var pct = ((minutes - range.min) / (range.max - range.min)) * 100;
      range.style.setProperty('--fill', pct + '%');

      $('#minutesOut').textContent = minutes.toLocaleString();
      $('#estName').textContent    = pick.name;
      $('#estUsage').textContent   = minutes.toLocaleString() + ' credits';

      if (pick.price === 0) {
        $('#estPrice').textContent = '$0 forever';
        $('#estLeft').textContent  = Math.max(0, 100 - minutes).toLocaleString() + ' credits left';
        $('#estCost').textContent  = '$0.00 / min';
      } else {
        $('#estPrice').textContent = '$' + pick.price.toFixed(2) + ' / month' +
                                     (isAnnual ? ', billed yearly' : '');
        $('#estLeft').textContent  = (pick.cap - minutes).toLocaleString() + ' credits left';
        $('#estCost').textContent  = '$' + (pick.price / minutes).toFixed(3) + ' / min';
      }

      var cta = $('#estCta');
      if (cta) cta.textContent = pick.cta;
    };

    range.addEventListener('input', renderEstimator);
    renderEstimator();
    document.addEventListener('cyclechange', renderEstimator);
  }

  /* keep the sliding plate aligned when the layout reflows or webfonts land */
  window.addEventListener('resize', applyCycle);
  window.addEventListener('load', applyCycle);

  applyCycle();
})();