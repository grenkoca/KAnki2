// Globals
var currentCardIndex = 0;
var correctAnswers = 0;
var incorrectAnswers = 0;
var deck = null;
var currentLevel = "all";
var fontLoaded = false;
var incorrectCardsQueue = [];
var inErrorReviewMode = false;
var showingStarredOnly = false;
var deviceScaleFactor = 1.0;
var lastShowAnswerTime = 0;
var starredCardsQueue = [];
var inStarredReviewMode = false;

// Debounced save: batch saves to avoid blocking the UI on every answer.
var saveDeckTimeout = null;
var pendingSave = false;

// Stable reference to the due cards array for the current session.
// Prevents card-jump bugs when getDueCards() re-queries and returns
// a different array (e.g., after cards are rescheduled mid-session).
var currentSessionDueCards = [];

// ── Scheduling Configuration ──────────────────────────────────────────────────────

// Default scheduling configuration (SM-2)
var defaultSchedConfig = {
  newPerDay: 20,
  reviewsPerDay: 200,
  learnSteps: [1, 10],
  relearnSteps: [10],
  graduatingIntervalGood: 1,
  graduatingIntervalEasy: 4,
  initialEase: 2.5,
  easyMultiplier: 1.3,
  hardMultiplier: 1.2,
  maximumReviewInterval: 36500,
  lapseMultiplier: 0.0,
  minimumLapseInterval: 1,
  leechThreshold: 8,
  leechAction: 'tag',
  fuzzEnabled: true,
  fuzzFactor: 0.15,
  buryNew: false,
  buryReviews: false,
};

// Anki-inspired presets
var schedPresets = {
  default: {
    newPerDay: 20, reviewsPerDay: 200,
    learnSteps: [1, 10], relearnSteps: [10],
    graduatingIntervalGood: 1, graduatingIntervalEasy: 4,
    initialEase: 2.5, easyMultiplier: 1.3, hardMultiplier: 1.2,
    maximumReviewInterval: 36500,
  },
  fast: {
    newPerDay: 50, reviewsPerDay: 500,
    learnSteps: [1, 10], relearnSteps: [10],
    graduatingIntervalGood: 1, graduatingIntervalEasy: 2,
    initialEase: 2.65, easyMultiplier: 1.25, hardMultiplier: 1.2,
    maximumReviewInterval: 36500,
  },
  thorough: {
    newPerDay: 10, reviewsPerDay: 100,
    learnSteps: [1, 10], relearnSteps: [10],
    graduatingIntervalGood: 2, graduatingIntervalEasy: 7,
    initialEase: 2.5, easyMultiplier: 1.3, hardMultiplier: 1.2,
    maximumReviewInterval: 36500,
  },
  beginner: {
    newPerDay: 20, reviewsPerDay: 200,
    learnSteps: [1, 10], relearnSteps: [10],
    graduatingIntervalGood: 1, graduatingIntervalEasy: 4,
    initialEase: 2.65, easyMultiplier: 1.25, hardMultiplier: 1.2,
    maximumReviewInterval: 36500,
  },
  intermediate: {
    newPerDay: 20, reviewsPerDay: 200,
    learnSteps: [1, 10], relearnSteps: [10],
    graduatingIntervalGood: 1, graduatingIntervalEasy: 4,
    initialEase: 2.5, easyMultiplier: 1.3, hardMultiplier: 1.2,
    maximumReviewInterval: 36500,
  },
  advanced: {
    newPerDay: 20, reviewsPerDay: 200,
    learnSteps: [1, 10], relearnSteps: [10],
    graduatingIntervalGood: 1, graduatingIntervalEasy: 4,
    initialEase: 2.5, easyMultiplier: 1.3, hardMultiplier: 1.2,
    maximumReviewInterval: 36500,
  },
};

var SCHED_CONFIG = null; // Loaded from localStorage on init
var currentPresetName = 'default';

// ── Scheduling Config Persistence ─────────────────────────────────────────────

function loadSchedConfig() {
  try {
    var saved = localStorage.getItem('kanki_sched_config');
    if (saved) {
      SCHED_CONFIG = JSON.parse(saved);
      // Fill in any missing fields with defaults
      for (var key in defaultSchedConfig) {
        if (SCHED_CONFIG[key] === undefined) {
          SCHED_CONFIG[key] = defaultSchedConfig[key];
        }
      }
      log("Loaded scheduling config from localStorage");
      return;
    }
  } catch (e) {
    log("Error loading sched config: " + e.message);
  }
  // Use defaults
  SCHED_CONFIG = JSON.parse(JSON.stringify(defaultSchedConfig));
  currentPresetName = 'default';
  log("Using default scheduling config");
}

function saveSchedConfig() {
  try {
    localStorage.setItem('kanki_sched_config', JSON.stringify(SCHED_CONFIG));
    log("Scheduling config saved to localStorage");
  } catch (e) {
    log("Error saving sched config: " + e.message);
  }
}

function clonePreset() {
  var name = prompt("Enter a name for the cloned preset:");
  if (!name || name.trim() === "") return;
  name = name.trim();
  schedPresets[name] = JSON.parse(JSON.stringify(SCHED_CONFIG));
  currentPresetName = name;
  log("Created preset: " + name);
}

// ── Card Migration (legacy difficulty → reviewState) ─────────────────────────

function migrateCard(card) {
  if (card.reviewState) return card; // already migrated

  var ease = SCHED_CONFIG ? SCHED_CONFIG.initialEase : 2.5;
  card.reviewState = {
    scheduledDays: Math.max(0, card.difficulty),
    elapsedDays: 0,
    easeFactor: ease,
    lapses: 0,
    leeched: false
  };
  return card;
}

function migrateAllCards() {
  var migrated = 0;
  for (var i = 0; i < deck.cards.length; i++) {
    if (deck.cards[i].reviewState === undefined) {
      migrateCard(deck.cards[i]);
      migrated++;
    }
  }
  if (migrated > 0) {
    log("Migrated " + migrated + " cards to new scheduling model");
  }
}

// ── SM-2 Scheduling (replaces old calculateNextReview / setNextReviewTime) ────

// Compute interval in days using SM-2 formulas
function computeSM2Interval(card, button) {
  var rs = card.reviewState;
  var cfg = SCHED_CONFIG;
  var now = new Date().getTime();

  // Days since card was last scheduled (including lateness)
  var daysLate = 0;
  if (rs.scheduledDays > 0) {
    var lastReviewMs = card.lastViewed || now;
    var daysSinceReview = (now - lastReviewMs) / (24 * 60 * 60 * 1000);
    daysLate = Math.max(0, daysSinceReview - rs.scheduledDays);
  }

  var currentInterval = rs.scheduledDays;

  switch (button) {
    case 'again':
      // Lapse: ease decreases, interval resets to relearn step
      rs.easeFactor = Math.max(1.3, rs.easeFactor - 0.2);
      rs.lapses++;
      var lapseInterval = Math.max(cfg.minimumLapseInterval,
        Math.round(currentInterval * cfg.lapseMultiplier));
      // Store the relearn interval for when the card graduates
      card._lapseInterval = lapseInterval;
      // Card goes into learning — set scheduledDays to a relearn step
      // We'll set it to the first relearn step (in days)
      if (cfg.relearnSteps && cfg.relearnSteps.length > 0) {
        rs.scheduledDays = Math.max(1, Math.ceil(cfg.relearnSteps[0] / 1440));
      } else {
        rs.scheduledDays = 1;
      }
      rs.elapsedDays = 0;
      return rs.scheduledDays;

    case 'hard':
      rs.easeFactor = Math.max(1.3, rs.easeFactor - 0.15);
      var hardInterval = Math.max(currentInterval * cfg.hardMultiplier,
        currentInterval + 1);
      rs.scheduledDays = Math.min(cfg.maximumReviewInterval,
        Math.max(1, Math.round(hardInterval)));
      rs.elapsedDays += 1;
      return rs.scheduledDays;

    case 'good':
      var goodInterval;
      if (currentInterval === 0) {
        // First good answer: use graduating interval
        goodInterval = cfg.graduatingIntervalGood;
      } else {
        // Subsequent: (currentInterval + daysLate/2) * easeFactor
        goodInterval = (currentInterval + daysLate / 2) * rs.easeFactor;
      }
      rs.scheduledDays = Math.min(cfg.maximumReviewInterval,
        Math.max(1, Math.round(goodInterval)));
      rs.elapsedDays += 1;
      return rs.scheduledDays;

    case 'easy':
      rs.easeFactor += 0.15;
      var easyInterval;
      if (currentInterval === 0) {
        easyInterval = cfg.graduatingIntervalEasy;
      } else {
        easyInterval = (currentInterval + daysLate) * rs.easeFactor * cfg.easyMultiplier;
      }
      // Easy is at least good + 1
      var easyGood;
      if (currentInterval === 0) {
        easyGood = cfg.graduatingIntervalGood + 1;
      } else {
        easyGood = Math.round((currentInterval + daysLate / 2) * rs.easeFactor) + 1;
      }
      rs.scheduledDays = Math.min(cfg.maximumReviewInterval,
        Math.max(easyGood, Math.round(easyInterval)));
      rs.elapsedDays += 1;
      return rs.scheduledDays;

    default:
      return rs.scheduledDays;
  }
}

// Apply fuzz to an interval (±fuzzFactor as fraction)
function applyFuzz(interval) {
  var cfg = SCHED_CONFIG;
  if (!cfg.fuzzEnabled || interval <= 1) return interval;
  var fuzzRange = Math.max(1, Math.round(interval * cfg.fuzzFactor));
  var jitter = Math.floor(Math.random() * (2 * fuzzRange + 1)) - fuzzRange;
  return Math.max(1, interval + jitter);
}

// Set next review time using SM-2 with current config
function setNextReviewTime(card, button) {
  var now = new Date().getTime();

  card.history.push({
    date: now,
    result: true,
    difficulty: button
  });

  var interval = computeSM2Interval(card, button);
  interval = applyFuzz(interval);

  // Convert scheduledDays back to a timestamp
  var nextReviewMs = now + (interval * 24 * 60 * 60 * 1000);
  card.nextReview = nextReviewMs;

  return card;
}

// ── Manage screen state (selection / tagging)
var manageCurrentPage = 0;
var CARDS_PER_PAGE = 10;
var manageSelectedIndices = [];
var manageFilterLevel = 'all';

// Browse screen state (read-only)
var browseCurrentPage = 0;
var browseFilterLevel = 'all';

var currentScreen = 'overview';

// Initialize configuration from vocabulary.js if available
function initializeConfig() {
  if (typeof KANKI_CONFIG !== 'undefined') {
    appLanguage = KANKI_CONFIG.language || appLanguage;
    appLevels = KANKI_CONFIG.levels || appLevels;
    // Sort levels alphabetically (case-insensitive)
    appLevels.sort(function(a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
    log("Loaded custom configuration: " + appLanguage + " with levels: " + appLevels.join(", "));
  } else {
    log("Using default configuration");
  }
}

// Truncate level name if longer than 32 chars: first 29 chars + "..."
function truncateLevel(name) {
  if (name.length > 32) {
    return name.substring(0, 29) + '...';
  }
  return name;
}

// The logging function — writes to a visible div on-screen
function log(logStuff) {
  var logElement = document.getElementById("log");
  if (logElement) {
    logElement.innerHTML += "<p>" + logStuff + "</p>";
  }
  if (window.console && console.log) {
    console.log("[KAnki] " + logStuff);
  }
}

// Global image error handler — logs failures and replaces broken images with a fallback
function setupImageErrorHandling() {
  document.addEventListener('error', function(e) {
    if (e.target && e.target.tagName === 'IMG') {
      var src = e.target.src || '';
      log("Image load failed: " + src.substring(0, 120));
      e.target.onerror = null;
      e.target.style.display = 'none';
      var placeholder = document.createElement('div');
      placeholder.style.cssText = 'text-align:center;color:#999;padding:20px;border:1px dashed #ccc;margin:4px 0;';
      placeholder.textContent = '[Image not found: ' + src.substring(src.lastIndexOf('/') + 1) + ']';
      e.target.parentNode.insertBefore(placeholder, e.target);
    }
  }, true);
}

// ─── Fullscreen Image Viewer ─────────────────────────────────────────────────
// Safari 5 compatible: no object-fit, no CSS transitions.
// Uses gesture events (iOS) for pinch-to-zoom, touch events for drag-to-pan.

var imageViewerOpen = false;

// Viewer state
var ivScale = 1;              // current zoom scale
var ivPanX = 0;               // current pan offset X
var ivPanY = 0;               // current pan offset Y
var ivImgNaturalW = 0;        // image natural width
var ivImgNaturalH = 0;        // image natural height
var ivViewW = 0;              // viewport width
var ivViewH = 0;              // viewport height

// Pan tracking
var ivIsPanning = false;
var ivPanStartX = 0;
var ivPanStartY = 0;
var ivPanOffsetStartX = 0;
var ivPanOffsetStartY = 0;

// Double-tap detection
var ivLastTapTime = 0;
var ivSingleTapTimer = null;

// Pinch gesture state
var ivGestureStartScale = 1;
var ivGestureStartCenterX = 0;
var ivGestureStartCenterY = 0;

function setupImageTapHandling() {
  var cardContainer = document.getElementById("cardContainer");
  if (!cardContainer) return;

  cardContainer.addEventListener('click', function(e) {
    if (e.target && e.target.tagName === 'IMG') {
      e.preventDefault();
      e.stopPropagation();
      openImageViewer(e.target.src);
    }
  });
}

function openImageViewer(src) {
  if (imageViewerOpen) return;
  imageViewerOpen = true;
  ivScale = 1;
  ivPanX = 0;
  ivPanY = 0;

  var overlay = document.getElementById("imageViewerOverlay");
  var img = document.getElementById("imageViewerImg");

  // Reset styles
  img.style.width = '';
  img.style.height = '';
  img.style.position = '';
  img.style.left = '';
  img.style.top = '';
  img.style.marginLeft = '';
  img.style.marginTop = '';
  img.style.webkitTransform = '';
  img.style.transform = '';

  // Get viewport dimensions
  ivViewW = window.innerWidth || document.documentElement.clientWidth;
  ivViewH = window.innerHeight || document.documentElement.clientHeight;

  // Load image to get natural dimensions, then size it
  var tempImg = new Image();
  tempImg.onload = function() {
    ivImgNaturalW = tempImg.naturalWidth || tempImg.width;
    ivImgNaturalH = tempImg.naturalHeight || tempImg.height;

    // Calculate fit-to-screen dimensions (leave 5% padding)
    var padW = ivViewW * 0.95;
    var padH = ivViewH * 0.95;
    var ratio = Math.min(padW / ivImgNaturalW, padH / ivImgNaturalH);
    var displayW = Math.round(ivImgNaturalW * ratio);
    var displayH = Math.round(ivImgNaturalH * ratio);

    img.src = src;
    img.style.width = displayW + 'px';
    img.style.height = displayH + 'px';
    img.style.position = 'absolute';
    img.style.left = '0';
    img.style.top = '0';

    // Center the image using marginLeft/marginTop (not transform)
    // so that transform is only used for pan/zoom deltas
    ivPanX = Math.round((ivViewW - displayW) / 2);
    ivPanY = Math.round((ivViewH - displayH) / 2);
    img.style.marginLeft = ivPanX + 'px';
    img.style.marginTop = ivPanY + 'px';

    overlay.style.display = 'block';
  };
  tempImg.onerror = function() {
    // Fallback: just set src and let browser size it
    img.src = src;
    overlay.style.display = 'block';
  };
  tempImg.src = src;
}

function closeImageViewer() {
  if (!imageViewerOpen) return;
  imageViewerOpen = false;

  var overlay = document.getElementById("imageViewerOverlay");
  overlay.style.display = 'none';

  // E-ink ghosting fix: flash white, then black, then restore
  flashDisplayForEInkRefresh();
}

function applyImageViewerTransform() {
  var img = document.getElementById("imageViewerImg");
  if (!img) return;

  var displayW = ivImgNaturalW;  // fit-to-screen display width
  var displayH = ivImgNaturalH;  // fit-to-screen display height

  var scaledW = displayW * ivScale;
  var scaledH = displayH * ivScale;

  // Clamp pan so image doesn't drift completely off-screen
  var maxPanX = Math.max(0, (scaledW - ivViewW) / 2);
  var maxPanY = Math.max(0, (scaledH - ivViewH) / 2);
  ivPanX = Math.max(-maxPanX, Math.min(maxPanX, ivPanX));
  ivPanY = Math.max(-maxPanY, Math.min(maxPanY, ivPanY));

  // At scale ~1, use marginLeft/marginTop for centering (no transform)
  // At scale != 1, use transform-origin at image center so scale() grows
  // from the center, then translate() for pan offset.
  if (ivScale <= 1.0001 && ivScale >= 0.9999) {
    img.style.webkitTransform = '';
    img.style.transform = '';
    img.style.marginLeft = ivPanX + 'px';
    img.style.marginTop = ivPanY + 'px';
  } else {
    // transform-origin at the image center so scale() grows from center
    img.style.webkitTransformOrigin = (displayW / 2) + 'px ' + (displayH / 2) + 'px';
    img.style.transformOrigin = (displayW / 2) + 'px ' + (displayH / 2) + 'px';
    // translate by the centering offset, then scale from center
    img.style.webkitTransform = 'translate(' + ivPanX + 'px, ' + ivPanY + 'px) scale(' + ivScale + ')';
    img.style.transform = 'translate(' + ivPanX + 'px, ' + ivPanY + 'px) scale(' + ivScale + ')';
    img.style.marginLeft = '0';
    img.style.marginTop = '0';
  }
}

// Handle taps and gestures on the fullscreen viewer overlay
function setupImageViewerTapHandling() {
  var overlay = document.getElementById("imageViewerOverlay");
  if (!overlay) return;

  // ── Double-tap to close (on overlay background) ──────────────────────
  overlay.addEventListener('touchend', function(e) {
    if (e.touches.length > 0) return; // Still have fingers down, not a tap

    var now = Date.now();
    var changedTouch = e.changedTouches[0];
    var target = changedTouch.target;

    // Check if this is a double-tap
    if (now - ivLastTapTime < 350) {
      clearTimeout(ivSingleTapTimer);
      ivLastTapTime = 0;
      closeImageViewer();
      e.preventDefault();
      return;
    }

    // Single tap on background (not on the image) — close
    if (target === overlay || target.id === "imageViewerContent") {
      clearTimeout(ivSingleTapTimer);
      ivSingleTapTimer = setTimeout(function() {
        if (imageViewerOpen) {
          closeImageViewer();
        }
      }, 350);
    }

    ivLastTapTime = now;
  }, false);

  // ── Pinch-to-zoom via iOS gesture events ─────────────────────────────
  overlay.addEventListener('gesturestart', function(e) {
    if (!imageViewerOpen) return;
    e.preventDefault();
    ivGestureStartScale = ivScale;

    // Calculate gesture center relative to the image
    var rect = document.getElementById("imageViewerImg").getBoundingClientRect();
    ivGestureStartCenterX = e.clientX - rect.left;
    ivGestureStartCenterY = e.clientY - rect.top;
  }, false);

  overlay.addEventListener('gesturechange', function(e) {
    if (!imageViewerOpen) return;
    e.preventDefault();

    // Scale between 0.5x and 5x
    var newScale = Math.max(0.5, Math.min(5, ivGestureStartScale * e.scale));

    // Adjust pan so the gesture center stays stable
    var scaleRatio = newScale / ivScale;
    ivPanX = ivPanX * scaleRatio;
    ivPanY = ivPanY * scaleRatio;
    ivScale = newScale;

    applyImageViewerTransform();
  }, false);

  overlay.addEventListener('gestureend', function(e) {
    if (!imageViewerOpen) return;
    e.preventDefault();
  }, false);

  // ── Drag-to-pan (one finger, when zoomed in) ─────────────────────────
  overlay.addEventListener('touchstart', function(e) {
    if (!imageViewerOpen) return;
    if (e.touches.length !== 1) return;
    if (ivScale <= 1) return; // Only pan when zoomed in

    var touch = e.touches[0];
    ivIsPanning = true;
    ivPanStartX = touch.clientX;
    ivPanStartY = touch.clientY;
    ivPanOffsetStartX = ivPanX;
    ivPanOffsetStartY = ivPanY;
  }, false);

  overlay.addEventListener('touchmove', function(e) {
    if (!imageViewerOpen) return;
    if (!ivIsPanning) return;
    if (e.touches.length !== 1) {
      ivIsPanning = false;
      return;
    }

    e.preventDefault();
    var touch = e.touches[0];
    ivPanX = ivPanOffsetStartX + (touch.clientX - ivPanStartX);
    ivPanY = ivPanOffsetStartY + (touch.clientY - ivPanStartY);
    applyImageViewerTransform();
  }, false);

  overlay.addEventListener('touchend', function(e) {
    if (ivIsPanning && e.touches.length === 0) {
      ivIsPanning = false;
    }
  }, false);

  // Also handle click for non-touch devices (testing in desktop browser)
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay || e.target.id === "imageViewerContent") {
      closeImageViewer();
    }
  });
}

// E-ink ghosting fix: flash white then black to force full particle reset
function flashDisplayForEInkRefresh() {
  var flash = document.getElementById("displayFlash");
  if (!flash) return;

  // Phase 1: Flash white
  flash.style.display = "block";
  flash.style.backgroundColor = "#ffffff";

  setTimeout(function() {
    // Phase 2: Flash black
    flash.style.backgroundColor = "#000000";

    setTimeout(function() {
      // Phase 3: Remove flash, content restored underneath
      flash.style.display = "none";
    }, 100);
  }, 100);
}

// Pass-through: images load via direct <img src=""> tags; the global error
// handler (setupImageErrorHandling) shows a placeholder for any that fail.
function resolveImagePathsInHTML(html) {
  return html;
}

function loadLanguageFont() {
  log("Loading " + appLanguage + " font...");

  document.documentElement.style.fontFamily = "LanguageFont, sans-serif";

  setTimeout(function() {
    fontLoaded = true;
    log(appLanguage + " font loading completed");
    showDeckOverview();
  }, 1000);
}

// Initialize fixed element heights to prevent layout shifts on e-ink display
function initializeFixedHeights() {
  log("Initializing fixed element heights for e-ink optimization...");

  var viewport = detectViewportAndAdjust();
  var cardContainer = document.getElementById("cardContainer");
  var controlButtons = document.getElementById("controlButtons");
  var intervalButtons = document.getElementById("intervalButtons");

  var backMinHeight = "50px";
  var notesMinHeight = "20px";

  if (viewport.width >= 1800 || viewport.height >= 2400) {
    backMinHeight = "120px";
    notesMinHeight = "40px";
  } else if (viewport.width >= 1050 || viewport.height >= 1400) {
    backMinHeight = "90px";
    notesMinHeight = "30px";
  } else if (viewport.width >= 750 || viewport.height >= 1000) {
    backMinHeight = "65px";
    notesMinHeight = "25px";
  }

  // In review mode the CSS handles card / control dimensions; just ensure overflow
  if (cardContainer) {
    cardContainer.style.overflowY = "auto";
    cardContainer.style.overflowX = "hidden";
  }

  if (intervalButtons) {
    intervalButtons.style.display = "block";
    intervalButtons.style.visibility = "hidden";
    intervalButtons.offsetHeight; // force reflow so hidden buttons don't shift layout
  }

  var backElement = document.getElementById("cardBack");
  if (backElement) {
    backElement.style.minHeight = backMinHeight;
  }

  var notesElement = document.getElementById("cardNotes");
  if (notesElement) {
    notesElement.style.minHeight = notesMinHeight;
  }

  log("Fixed element heights initialized for viewport " + viewport.width + "x" + viewport.height);
}

// Detect viewport size and adjust UI accordingly
function detectViewportAndAdjust() {
  var width = window.innerWidth || document.documentElement.clientWidth || document.body.clientWidth;
  var height = window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight;

  log("Detected viewport size: " + width + "x" + height);

  var body = document.body;

  body.classList.remove('kindle-small', 'kindle-medium', 'kindle-large', 'kindle-xlarge');

  if (width <= 600) {
    body.classList.add('kindle-small');
  } else if (width <= 850) {
    body.classList.add('kindle-medium');
  } else if (width <= 1300) {
    body.classList.add('kindle-large');
  } else {
    body.classList.add('kindle-xlarge');
  }

  return { width: width, height: height };
}

// Handle window resize or orientation change events
function handleViewportChange() {
  if (window.resizeTimer) {
    clearTimeout(window.resizeTimer);
  }

  window.resizeTimer = setTimeout(function() {
    log("Viewport changed, reinitializing...");
    detectDeviceAndSetScaling();
    initializeFixedHeights();
    if (currentScreen === 'review') {
      displayCurrentCard(currentSessionDueCards, false);
    }
    updateProgressDisplay();
    updateLevelDisplay();

    var toast = document.getElementById("toastNotification");
    if (toast && toast.style.display === "block") {
      var screenHeight = window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight;
      toast.style.top = (screenHeight > 1000) ? "120px" : "80px";
    }

    var overlay = document.getElementById("confirmationOverlay");
    if (overlay && overlay.style.display === "block") {
      var popup = overlay.querySelector(".popup");
      var screenHeight = window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight;
      var topPosition = Math.round(screenHeight / 2 - 100);
      popup.style.top = topPosition + "px";
    }
  }, 250);
}

// Add event listeners for window resize and orientation change
function addViewportListeners() {
  if (window.addEventListener) {
    window.addEventListener('resize', handleViewportChange, false);
    window.addEventListener('orientationchange', handleViewportChange, false);
    log("Added viewport change listeners");
  }
}

// Create flashcard deck data structure
function createDeck() {
  return {
    cards: [],
    lastStudied: new Date().getTime(),
    name: appLanguage + " Flashcards"
  };
}

function createCard(front, reading, back, notes, level, difficulty, cid) {
  var displayText = front;
  if (reading) {
    displayText = front + " (" + reading + ")";
  }

  return {
    id: cid || null,
    front: displayText,
    back: back,
    notes: notes || "",
    level: level || appLevels[0],
    difficulty: difficulty || 0,
    nextReview: new Date().getTime(),
    history: [],
    starred: false,
    timesViewed: 0,
    lastViewed: null,
    suspended: false,
    tags: []
  };
}

// Default deck with words from vocabulary.js
function createDefaultDeck() {
  var deck = createDeck();

  if (typeof VOCABULARY !== 'undefined') {
    for (var level in VOCABULARY) {
      if (VOCABULARY.hasOwnProperty(level)) {
        for (var i = 0; i < VOCABULARY[level].length; i++) {
          var word = VOCABULARY[level][i];
          var card = createCard(
            word.front,
            word.reading,
            word.back,
            word.notes,
            level,
            0,
            word.cid || null
          );
          if (word.tags && word.tags.length)  card.tags      = word.tags.slice();
          if (word.suspended)                  card.suspended = true;
          deck.cards.push(card);
        }
      }
    }

    log("Created default deck with " + deck.cards.length + " cards");
  } else {
    log("Warning: VOCABULARY not found, using minimal deck");
    deck.cards.push(createCard("Example", null, "Translation", "Sample card", appLevels[0], 0));
    deck.cards.push(createCard("Second", null, "Another translation", "Another sample", appLevels[0], 0));
  }

  return deck;
}

// Save deck to localStorage
function saveDeck() {
  if (deck) {
    try {
      localStorage.setItem('kanki_deck', JSON.stringify(deck));
      log("Deck saved to localStorage");
    } catch (e) {
      log("Error saving deck: " + e.message);
    }
  }
}

// Save a single card's state to localStorage without serializing the entire deck.
// Called from review paths to avoid the ~500ms+ freeze of JSON.stringify(6000 cards).
// Uses card.id as key; cards without an id get one assigned.
function saveCard(card) {
  if (!deck || !card) return;
  if (!card.id) card.id = 'card_' + deck.cards.indexOf(card);
  try {
    var cards = JSON.parse(localStorage.getItem('kanki_deck_cards') || '{}');
    cards[card.id] = card;
    localStorage.setItem('kanki_deck_cards', JSON.stringify(cards));
  } catch (e) {
    log("Error saving card: " + e.message);
  }
}

// Migrate index-based card IDs to stable CIDs from VOCABULARY.
// Only runs when VOCABULARY entries carry a 'cid' field (i.e. after generate-cids.js
// has been run). Moves kanki_deck_cards entries from old keys to new CID keys so
// per-card progress is not lost during the transition.
function assignStableCids() {
  if (typeof VOCABULARY === 'undefined') return;

  // Build ordered CID list matching createDefaultDeck() iteration order
  var vocabCids = [];
  for (var level in VOCABULARY) {
    if (VOCABULARY.hasOwnProperty(level)) {
      for (var i = 0; i < VOCABULARY[level].length; i++) {
        vocabCids.push(VOCABULARY[level][i].cid || null);
      }
    }
  }

  // Only proceed if VOCABULARY has CIDs and card counts match
  if (!vocabCids[0] || vocabCids.length !== deck.cards.length) return;

  var cardSaves = {};
  try {
    cardSaves = JSON.parse(localStorage.getItem('kanki_deck_cards') || '{}');
  } catch (e) {}

  var migrated = 0;
  var savesChanged = false;
  for (var i = 0; i < deck.cards.length; i++) {
    var c      = deck.cards[i];
    var newCid = vocabCids[i];
    if (!newCid || c.id === newCid) continue;

    // Remap per-card save entry from old key to new CID key
    if (c.id && cardSaves[c.id]) {
      cardSaves[newCid] = cardSaves[c.id];
      delete cardSaves[c.id];
      savesChanged = true;
    }

    c.id = newCid;
    migrated++;
  }

  if (migrated > 0) {
    log("Migrated " + migrated + " cards to stable CIDs");
    if (savesChanged) {
      try {
        localStorage.setItem('kanki_deck_cards', JSON.stringify(cardSaves));
      } catch (e) {
        log("Error saving migrated card IDs: " + e.message);
      }
    }
    // kanki_deck will be written on the next regular saveDeck() call
  }
}

// Load deck from localStorage or create a new one if none exists
function loadDeck() {
  try {
    var savedDeck = localStorage.getItem('kanki_deck');
    if (savedDeck) {
      deck = JSON.parse(savedDeck);
      log("Loaded saved deck with " + deck.cards.length + " cards");

      // Merge per-card incremental saves (from saveCard()) into the main deck.
      // This ensures card progress is preserved even when saveDeck() wasn't called.
      try {
        var cardSaves = JSON.parse(localStorage.getItem('kanki_deck_cards') || '{}');
        var merged = 0;
        for (var i = 0; i < deck.cards.length; i++) {
          var c = deck.cards[i];
          if (cardSaves[c.id]) {
            // Merge saved fields back into the card object
            var saved = cardSaves[c.id];
            c.difficulty = saved.difficulty;
            c.nextReview = saved.nextReview;
            c.history = saved.history;
            c.starred = saved.starred;
            c.timesViewed = saved.timesViewed;
            c.lastViewed = saved.lastViewed;
            c.suspended = saved.suspended;
            c.tags = saved.tags;
            if (saved.reviewState) c.reviewState = saved.reviewState;
            merged++;
          }
        }
        if (merged > 0) {
          log("Merged " + merged + " per-card saves into deck");
        }
      } catch (e) {
        log("Error merging per-card saves: " + e.message);
      }

      for (var i = 0; i < deck.cards.length; i++) {
        if (deck.cards[i].suspended === undefined) deck.cards[i].suspended = false;
        if (!deck.cards[i].tags) deck.cards[i].tags = [];
      }

      // One-time migration: assign stable CIDs if VOCABULARY now carries them
      assignStableCids();

      return true;
    }
  } catch (e) {
    log("Error loading deck: " + e.message);
  }

  deck = createDefaultDeck();
  log("Created new default deck");
  return false;
}

// Update status message for notifications
function updateStatusMessage(message) {
  var statusElement = document.getElementById("statusMessage");
  if (!statusElement) return;

  statusElement.textContent = message;
  statusElement.style.display = "block";

  setTimeout(function() {
    statusElement.style.display = "none";
  }, 3000);
}

// Show confirmation popup
function showConfirmation(message, onConfirm) {
  var overlay = document.getElementById("confirmationOverlay");
  var popup = overlay.querySelector(".popup");
  var messageElement = document.getElementById("confirmationMessage");
  var yesButton = document.getElementById("confirmYesBtn");
  var noButton = document.getElementById("confirmNoBtn");

  messageElement.textContent = message;

  var screenHeight = window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight;
  var topPosition = Math.round(screenHeight / 2 - 100);
  popup.style.top = topPosition + "px";

  yesButton.onclick = function() {
    overlay.style.display = "none";
    if (onConfirm) onConfirm();
  };

  noButton.onclick = function() {
    overlay.style.display = "none";
  };

  overlay.style.display = "block";
}

// Get cards due for review (filtered by level, capped by daily new/review limits)
function getDueCards() {
  var now = new Date().getTime();
  var cfg = SCHED_CONFIG;
  var newLimit    = cfg ? cfg.newPerDay     : 20;
  var reviewLimit = cfg ? cfg.reviewsPerDay : 200;
  var newCount    = 0;
  var reviewCount = 0;
  var dueCards    = [];

  for (var i = 0; i < deck.cards.length; i++) {
    var card = deck.cards[i];
    if (card.suspended) continue;
    if (card.nextReview <= now) {
      var levelMatch = (currentLevel === "all" || card.level === currentLevel);
      var starMatch  = (!showingStarredOnly || card.starred === true);

      if (levelMatch && starMatch) {
        var isNew = !card.history || card.history.length === 0;
        if (isNew) {
          if (newCount < newLimit) { newCount++; dueCards.push(card); }
        } else {
          if (reviewCount < reviewLimit) { reviewCount++; dueCards.push(card); }
        }
      }
    }
  }

  return dueCards;
}

// Get all starred cards across all decks/levels
function getAllStarredCards() {
  var starredCards = [];
  for (var i = 0; i < deck.cards.length; i++) {
    var card = deck.cards[i];
    if (card.starred === true && !card.suspended) {
      starredCards.push(card);
    }
  }
  return starredCards;
}

// Get starred cards that have been reviewed in the current session
function getStarredCardsFromCurrentSession() {
  var starredCards = [];

  for (var i = 0; i < deck.cards.length; i++) {
    var card = deck.cards[i];
    if (card.starred === true && card.timesViewed > 0) {
      var levelMatch = (currentLevel === "all" || card.level === currentLevel);
      if (levelMatch) {
        starredCards.push(card);
      }
    }
  }

  return starredCards;
}

// Display current card.
// 'dueCards' is the stable reference to the session's due cards array.
// This is never re-queried during the session — it is computed once at
// session start (like Anki's CardQueues). Prevents card-jump when cards
// are rescheduled mid-session.
// 'showAnswer' and 'card' are as before; 'card' overrides dueCards[index].
function displayCurrentCard(dueCards, showAnswer, card) {
  var cardContainer = document.getElementById("cardContainer");
  var levelBadge = document.getElementById("levelBadge");
  var frontElement = document.getElementById("cardFront");
  var backElement = document.getElementById("cardBack");
  var notesElement = document.getElementById("cardNotes");
  var dividerElement = document.getElementById("cardDivider");
  var showAnswerBtn = document.getElementById("showAnswerBtn");
  var intervalButtons = document.getElementById("intervalButtons");

  backElement.style.display = "none";
  notesElement.style.display = "none";
  if (dividerElement) dividerElement.style.display = "none";

  if (!dueCards || dueCards.length === 0) {
    cardContainer.style.display = "block";
    frontElement.innerHTML = "<div style='font-size: 0.7em; font-weight: normal; text-align: center; padding: 20px;'><p>No cards due for review!</p><p>Great job!</p></div>";
    levelBadge.style.display = "none";
    showAnswerBtn.style.display = "none";
    intervalButtons.style.display = "block";
    intervalButtons.style.visibility = "hidden";
    document.getElementById("cardStats").style.display = "none";

    if (incorrectCardsQueue.length > 0) {
      showErrorReviewPrompt();
    } else if (getStarredCardsFromCurrentSession().length > 0 && !inStarredReviewMode) {
      showStarredReviewPrompt();
    }

    updateProgressDisplay();
    return;
  }
  cardContainer.style.display = "block";
  document.getElementById("cardStats").style.display = "block";

  // Use the passed card if provided, otherwise index into the stable dueCards array.
  var displayCard = card || dueCards[currentCardIndex % dueCards.length];

  levelBadge.style.display = "block";
  levelBadge.textContent = displayCard.level;

  frontElement.innerHTML = resolveImagePathsInHTML(displayCard.front);
  backElement.innerHTML = resolveImagePathsInHTML(displayCard.back);

  notesElement.innerHTML = resolveImagePathsInHTML(displayCard.notes || "");

  applyTextScaling(frontElement, backElement, notesElement);

  updateStarButton(displayCard.starred);

  if (!showAnswer) {
    displayCard.timesViewed = (displayCard.timesViewed || 0) + 1;
    displayCard.lastViewed = new Date().getTime();
    // Don't save on every view — answer handlers call saveDeck() and Kindle
    // is too slow to serialize 6000+ cards on each card display.
  }

  updateCardStats(displayCard);
  updateScrollIndicators();

  if (showAnswer) {
    backElement.style.display = "block";
    notesElement.style.display = "block";
    if (dividerElement) dividerElement.style.display = "block";
    showAnswerBtn.style.display = "none";
    intervalButtons.style.display = "block";
    intervalButtons.style.visibility = "visible";
    setTimeout(updateScrollIndicators, 100);
  } else {
    showAnswerBtn.style.display = "block";
    intervalButtons.style.display = "none";
  }

  updateProgressDisplay();
}

// Apply automatic text scaling based on content length
function applyTextScaling(frontElement, backElement, notesElement) {
  var cardContainer = document.getElementById("cardContainer");
  if (!cardContainer || !frontElement || !backElement) return;

  var frontText = frontElement.textContent || frontElement.innerHTML;
  var backText = backElement.textContent || backElement.innerHTML;
  var notesText = notesElement ? (notesElement.textContent || '') : '';

  var frontLength = frontText ? frontText.length : 0;
  var backLength = backText ? backText.length : 0;
  var notesLength = notesText ? notesText.length : 0;

  var maxLength = Math.max(frontLength, backLength);
  var totalLength = frontLength + backLength + notesLength;

  var baseFrontSize = 2.0;
  var baseBackSize = 1.5;
  var baseNotesSize = 0.9;

  var shortText = 50;
  var mediumText = 200;
  var longText = 500;
  var veryLongText = 1000;

  var frontScale = 1.0;
  var backScale = 1.0;
  var notesScale = 1.0;

  if (maxLength <= shortText) {
    frontScale = 1.0;
    backScale = 1.0;
  } else if (maxLength <= mediumText) {
    frontScale = 0.85;
    backScale = 0.85;
  } else if (maxLength <= longText) {
    frontScale = 0.7;
    backScale = 0.7;
  } else if (maxLength <= veryLongText) {
    frontScale = 0.55;
    backScale = 0.55;
  } else {
    frontScale = 0.45;
    backScale = 0.45;
  }

  if (totalLength > veryLongText * 1.5) {
    frontScale *= 0.85;
    backScale *= 0.85;
  } else if (totalLength > veryLongText) {
    frontScale *= 0.9;
    backScale *= 0.9;
  }

  var minFrontSize = 0.8;
  var minBackSize = 0.6;
  var minNotesSize = 0.6;

  frontScale = Math.max(minFrontSize / baseFrontSize, frontScale);
  backScale = Math.max(minBackSize / baseBackSize, backScale);
  notesScale = Math.max(minNotesSize / baseNotesSize, notesScale);

  frontElement.style.fontSize = (baseFrontSize * frontScale) + "em";
  backElement.style.fontSize = (baseBackSize * backScale) + "em";
  notesElement.style.fontSize = (baseNotesSize * notesScale) + "em";
}

function updateProgressDisplay() {
  var progressElement = document.getElementById("progressDisplay");
  if (!progressElement) return;

  if (inErrorReviewMode) {
    progressElement.textContent = "Review: " + (currentCardIndex + 1) +
      "/" + incorrectCardsQueue.length + " \u2022 \u2713" + correctAnswers +
      " \u2022 \u2717" + incorrectAnswers;
    return;
  }

  if (inStarredReviewMode) {
    progressElement.textContent = "\u2605 " + (currentCardIndex + 1) +
      "/" + starredCardsQueue.length + " starred";
    return;
  }

  var dueCards = getDueCards();

  if (dueCards.length === 0) {
    progressElement.textContent = "\u2713 Done!";
    return;
  }

  progressElement.textContent = (currentCardIndex % dueCards.length + 1) +
      "/" + dueCards.length + " \u2022 \u2713" + correctAnswers +
      " \u2022 \u2717" + incorrectAnswers;

  updateLevelDisplay();
}


function updateLevelDisplay() {
  var levelDisplayElement = document.getElementById("levelDisplay");
  if (!levelDisplayElement) return;
  var displayText = (currentLevel === "all" ? "All" : currentLevel);

  if (showingStarredOnly) {
    displayText += " \u2605";
  }

  displayText += " \u2022 Target\u2192Native";

  levelDisplayElement.textContent = displayText;
}

// Function to check if card content is scrollable and update visual indicators
function updateScrollIndicators() {
  var cardContainer = document.getElementById("cardContainer");
  if (!cardContainer) return;

  setTimeout(function() {
    var hasScrollableContent = cardContainer.scrollHeight > cardContainer.clientHeight;

    if (!hasScrollableContent) {
      cardContainer.classList.remove("scrollable-top");
      cardContainer.classList.remove("scrollable-bottom");
      return;
    }

    var isScrollableTop = cardContainer.scrollTop > 5;
    var isScrollableBottom = cardContainer.scrollTop < (cardContainer.scrollHeight - cardContainer.clientHeight - 5);

    if (isScrollableTop) {
      cardContainer.classList.add("scrollable-top");
    } else {
      cardContainer.classList.remove("scrollable-top");
    }

    if (isScrollableBottom && hasScrollableContent) {
      cardContainer.classList.add("scrollable-bottom");
    } else {
      cardContainer.classList.remove("scrollable-bottom");
    }

    cardContainer.removeEventListener('scroll', scrollHandler);
    cardContainer.addEventListener('scroll', scrollHandler);
  }, 50);
}

// Separate scroll handler function to avoid creating multiple listeners
function scrollHandler() {
  var cardContainer = document.getElementById("cardContainer");
  if (!cardContainer) return;

  var hasScrollableContent = cardContainer.scrollHeight > cardContainer.clientHeight;

  if (!hasScrollableContent) {
    cardContainer.classList.remove("scrollable-top");
    cardContainer.classList.remove("scrollable-bottom");
    return;
  }

  var isScrollableTop = cardContainer.scrollTop > 5;
  var isScrollableBottom = cardContainer.scrollTop < (cardContainer.scrollHeight - cardContainer.clientHeight - 5);

  if (isScrollableTop) {
    cardContainer.classList.add("scrollable-top");
  } else {
    cardContainer.classList.remove("scrollable-top");
  }

  if (isScrollableBottom && hasScrollableContent) {
    cardContainer.classList.add("scrollable-bottom");
  } else {
    cardContainer.classList.remove("scrollable-bottom");
  }
}

// Function to handle keyboard navigation for card scrolling
function initializeCardKeyboardNavigation() {
  document.addEventListener('keydown', function(event) {
    var cardContainer = document.getElementById("cardContainer");
    if (!cardContainer) return;

    var activeElement = document.activeElement;
    var isInputFocused = activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA');

    if (isInputFocused) return;

    var scrollAmount = 50;
    var handled = false;

    switch(event.key) {
      case 'ArrowUp':
        cardContainer.scrollBy(0, -scrollAmount);
        handled = true;
        break;
      case 'ArrowDown':
        cardContainer.scrollBy(0, scrollAmount);
        handled = true;
        break;
      case 'PageUp':
        cardContainer.scrollBy(0, -cardContainer.clientHeight * 0.8);
        handled = true;
        break;
      case 'PageDown':
        cardContainer.scrollBy(0, cardContainer.clientHeight * 0.8);
        handled = true;
        break;
      case 'Home':
        cardContainer.scrollTop = 0;
        handled = true;
        break;
      case 'End':
        cardContainer.scrollTop = cardContainer.scrollHeight;
        handled = true;
        break;
    }

    if (handled) {
      event.preventDefault();
      updateScrollIndicators();
    }
  });
}


function showAnswer() {
  lastShowAnswerTime = Date.now();

  if (inErrorReviewMode) {
    displayErrorCard(true);
  } else if (inStarredReviewMode) {
    displayStarredCard(true);
  } else {
    displayCurrentCard(currentSessionDueCards, true);
  }
}

// Handle answer with interval
function handleAnswerWithInterval(difficulty) {
  if (Date.now() - lastShowAnswerTime < 500) {
    return;
  }

  if (inErrorReviewMode) {
    answerErrorCardWithInterval(difficulty);
  } else if (inStarredReviewMode) {
    answerStarredCardWithInterval(difficulty);
  } else {
    if (!currentSessionDueCards || currentSessionDueCards.length === 0) return;

    var sessionLen = currentSessionDueCards.length;
    var cardIndex = currentCardIndex % sessionLen;
    var card = currentSessionDueCards[cardIndex];

    if (difficulty === 'again') {
      incorrectAnswers++;
      incorrectCardsQueue.push(card);
    } else {
      correctAnswers++;
    }

    setNextReviewTime(card, difficulty);

    currentCardIndex++;

    saveCard(card);

    if (currentCardIndex % sessionLen === 0 && incorrectCardsQueue.length > 0) {
      showErrorReviewPrompt();
    } else {
      var nextCard = null;
      if (currentCardIndex < currentSessionDueCards.length) {
        nextCard = currentSessionDueCards[currentCardIndex];
      }
      displayCurrentCard(currentSessionDueCards, false, nextCard);
    }
  }
}

// Handle error card review with intervals
function answerErrorCardWithInterval(difficulty) {
  if (currentCardIndex >= incorrectCardsQueue.length) return;

  var card = incorrectCardsQueue[currentCardIndex];

  setNextReviewTime(card, difficulty);

  incorrectCardsQueue[currentCardIndex] = null;

  currentCardIndex++;

  saveCard(card);

  if (currentCardIndex >= incorrectCardsQueue.length) {
    endErrorReview();
  } else {
    displayErrorCard(false);
  }
}

// Handle interval-based answer for starred cards
function answerStarredCardWithInterval(difficulty) {
  if (currentCardIndex >= starredCardsQueue.length) return;

  var card = starredCardsQueue[currentCardIndex];
  currentCardIndex++;

  setNextReviewTime(card, difficulty);
  saveCard(card);

  if (currentCardIndex >= starredCardsQueue.length) {
    endStarredReview();
  } else {
    displayStarredCard(false);
  }
}

// Initialize app on page load
function onPageLoad() {
  log("Application initializing...");

  // Start hidden; showDeckOverview will reveal mainContainer after font loads
  var reviewEl = document.getElementById("reviewScreen");
  var mainEl = document.getElementById("mainContainer");
  if (reviewEl) reviewEl.style.display = "none";

  initializeConfig();

  detectDeviceAndSetScaling();

  loadLanguageFont();

  initializeFixedHeights();

  detectViewportAndAdjust();

  addViewportListeners();

  loadDeck();

  // Load scheduling config and migrate cards to new model
  loadSchedConfig();
  migrateAllCards();

  var starredFilterBtn = document.getElementById("starredFilterBtn");
  var reverseToggleBtn = document.getElementById("reverseToggleBtn");

  if (starredFilterBtn && showingStarredOnly) {
    starredFilterBtn.classList.add("active");
  }

  if (reverseToggleBtn) {
    reverseToggleBtn.style.display = "none";
  }

  updateProgressDisplay();

  setTimeout(function() {
    updateScrollIndicators();
  }, 200);

  initializeCardKeyboardNavigation();

  setupImageErrorHandling();

  setupImageTapHandling();
  setupImageViewerTapHandling();

  log("Application initialized");
}

function showResetProgressConfirm() {
  showConfirmation("Are you sure you want to reset all cards' progress?", resetProgress);
}

function showResetAllConfirm() {
  showConfirmation("Are you sure you want to reset all data? This will delete all cards and progress.", resetAll);
}

function showToast(message, duration) {
  var toast = document.getElementById("toastNotification");
  if (!toast) return;

  toast.textContent = message;

  var screenHeight = window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight;
  toast.style.top = (screenHeight > 1000) ? "120px" : "80px";

  toast.style.display = "block";

  setTimeout(function() {
    toast.style.display = "none";
  }, duration || 2000);
}

// Reset progress
function resetProgress() {
  for (var i = 0; i < deck.cards.length; i++) {
    deck.cards[i].difficulty = 0;
    deck.cards[i].nextReview = new Date().getTime();
    deck.cards[i].history = [];
  }

  currentCardIndex = 0;
  correctAnswers = 0;
  incorrectAnswers = 0;
  incorrectCardsQueue = [];
  inErrorReviewMode = false;
  starredCardsQueue = [];
  inStarredReviewMode = false;

  saveDeck();
  showDeckOverview();
  showToast("Progress has been reset", 2000);
  log("Progress reset");
}

// Reset all
function resetAll() {
  deck = createDefaultDeck();
  currentCardIndex = 0;
  correctAnswers = 0;
  incorrectAnswers = 0;
  incorrectCardsQueue = [];
  inErrorReviewMode = false;
  showingStarredOnly = false;
  starredCardsQueue = [];
  inStarredReviewMode = false;

  saveDeck();
  showDeckOverview();
  showToast("All data has been reset", 2000);
  log("Complete reset performed");
}

// Show prompt to review errors
function showErrorReviewPrompt() {
  showConfirmation(
    "You have " + incorrectCardsQueue.length + " incorrect cards. Review them now?",
    startErrorReview
  );
}

// Show prompt to review starred cards
function showStarredReviewPrompt() {
  var starredCount = getStarredCardsFromCurrentSession().length;
  showConfirmation(
    "You have " + starredCount + " starred cards from this session. Review them now?",
    startStarredReview
  );
}

// Start error review mode
function startErrorReview() {
  if (incorrectCardsQueue.length === 0) return;

  inErrorReviewMode = true;
  showToast("Reviewing incorrect cards", 2000);

  var statusElement = document.getElementById("statusMessage");
  statusElement.textContent = "Error Review Mode";
  statusElement.style.display = "block";

  currentCardIndex = 0;
  displayErrorCard(false);
}

// Display error card
function displayErrorCard(showAnswer) {
  var cardContainer = document.getElementById("cardContainer");
  var levelBadge = document.getElementById("levelBadge");
  var frontElement = document.getElementById("cardFront");
  var backElement = document.getElementById("cardBack");
  var notesElement = document.getElementById("cardNotes");
  var dividerElement = document.getElementById("cardDivider");
  var showAnswerBtn = document.getElementById("showAnswerBtn");
  var intervalButtons = document.getElementById("intervalButtons");

  backElement.style.display = "none";
  notesElement.style.display = "none";
  if (dividerElement) dividerElement.style.display = "none";

  if (currentCardIndex >= incorrectCardsQueue.length) {
    endErrorReview();
    return;
  }

  cardContainer.style.display = "block";
  document.getElementById("cardStats").style.display = "block";

  var card = incorrectCardsQueue[currentCardIndex];

  levelBadge.style.display = "block";
  levelBadge.textContent = card.level;

  frontElement.innerHTML = resolveImagePathsInHTML(card.front);
  backElement.innerHTML = resolveImagePathsInHTML(card.back);

  notesElement.innerHTML = resolveImagePathsInHTML(card.notes || "");

  applyTextScaling(frontElement, backElement, notesElement);

  updateStarButton(card.starred);

  if (!showAnswer) {
    card.timesViewed = (card.timesViewed || 0) + 1;
    card.lastViewed = new Date().getTime();
  }

  updateCardStats(card);

  if (showAnswer) {
    backElement.style.display = "block";
    notesElement.style.display = "block";
    if (dividerElement) dividerElement.style.display = "block";
    showAnswerBtn.style.display = "none";
    intervalButtons.style.display = "block";
    intervalButtons.style.visibility = "visible";
  } else {
    showAnswerBtn.style.display = "block";
    intervalButtons.style.display = "none";
  }

  updateProgressDisplay();
}

function endErrorReview() {
  incorrectCardsQueue = incorrectCardsQueue.filter(function(card) {
    return card !== null;
  });

  inErrorReviewMode = false;

  var statusElement = document.getElementById("statusMessage");
  statusElement.style.display = "none";

  if (incorrectCardsQueue.length > 0) {
    showConfirmation(
      "You still have " + incorrectCardsQueue.length + " cards to master. Review them again?",
      startErrorReview
    );
  } else {
    showToast("All error cards reviewed successfully!", 2000);
    if (getStarredCardsFromCurrentSession().length > 0 && !inStarredReviewMode) {
      showStarredReviewPrompt();
    } else {
      currentCardIndex = 0;
      displayCurrentCard(currentSessionDueCards, false);
    }
  }
  saveDeck(); // endErrorReview: save full deck after error review session
}

// Start starred cards review mode
function startStarredReview() {
  starredCardsQueue = getStarredCardsFromCurrentSession();
  if (starredCardsQueue.length === 0) return;

  inStarredReviewMode = true;
  showToast("Reviewing starred cards", 2000);

  var statusElement = document.getElementById("statusMessage");
  statusElement.textContent = "Starred Cards Review";
  statusElement.style.display = "block";

  currentCardIndex = 0;
  displayStarredCard(false);
}

// Display starred card
function displayStarredCard(showAnswer) {
  var cardContainer = document.getElementById("cardContainer");
  var levelBadge = document.getElementById("levelBadge");
  var frontElement = document.getElementById("cardFront");
  var backElement = document.getElementById("cardBack");
  var notesElement = document.getElementById("cardNotes");
  var dividerElement = document.getElementById("cardDivider");
  var showAnswerBtn = document.getElementById("showAnswerBtn");
  var intervalButtons = document.getElementById("intervalButtons");

  backElement.style.display = "none";
  notesElement.style.display = "none";
  if (dividerElement) dividerElement.style.display = "none";

  if (currentCardIndex >= starredCardsQueue.length) {
    endStarredReview();
    return;
  }

  cardContainer.style.display = "block";
  document.getElementById("cardStats").style.display = "block";

  var card = starredCardsQueue[currentCardIndex];

  levelBadge.style.display = "block";
  levelBadge.textContent = card.level;

  frontElement.innerHTML = resolveImagePathsInHTML(card.front);
  backElement.innerHTML = resolveImagePathsInHTML(card.back);

  notesElement.innerHTML = resolveImagePathsInHTML(card.notes || "");

  applyTextScaling(frontElement, backElement, notesElement);

  updateStarButton(card.starred);

  if (!showAnswer) {
    card.timesViewed = (card.timesViewed || 0) + 1;
    card.lastViewed = new Date().getTime();
  }

  updateCardStats(card);
  updateScrollIndicators();

  if (showAnswer) {
    backElement.style.display = "block";
    notesElement.style.display = "block";
    if (dividerElement) dividerElement.style.display = "block";
    showAnswerBtn.style.display = "none";
    intervalButtons.style.display = "block";
    intervalButtons.style.visibility = "visible";
    setTimeout(updateScrollIndicators, 100);
  } else {
    showAnswerBtn.style.display = "block";
    intervalButtons.style.display = "none";
  }

  updateProgressDisplay();
}

function endStarredReview() {
  inStarredReviewMode = false;
  starredCardsQueue = [];

  var statusElement = document.getElementById("statusMessage");
  statusElement.style.display = "none";

  showToast("Starred cards review completed!", 2000);

  showingStarredOnly = false;
  var starredFilterBtn = document.getElementById("starredFilterBtn");
  if (starredFilterBtn) {
    starredFilterBtn.classList.remove("active");
  }

  currentCardIndex = 0;
  updateLevelDisplay();
  displayCurrentCard(currentSessionDueCards, false);
  saveDeck(); // endStarredReview: save full deck after starred review session
}

function toggleStarCurrentCard() {
  var card = null;
  var cardIndex = -1;

  if (inStarredReviewMode) {
    if (currentCardIndex >= starredCardsQueue.length) return;
    card = starredCardsQueue[currentCardIndex];
    cardIndex = currentCardIndex;
  } else if (inErrorReviewMode) {
    if (currentCardIndex >= incorrectCardsQueue.length) return;
    card = incorrectCardsQueue[currentCardIndex];
  } else {
    var dueCards = getDueCards();
    if (dueCards.length === 0) return;
    var cardIdx = currentCardIndex % dueCards.length;
    card = dueCards[cardIdx];
  }

  if (!card) return;

  var wasStarred = card.starred;
  card.starred = !card.starred;

  updateStarButton(card.starred);

  // If unstarred during starred review mode, remove from queue and show next card
  if (inStarredReviewMode && !card.starred && wasStarred) {
    // Card was starred, now unstarred - remove from queue
    starredCardsQueue.splice(cardIndex, 1);
    currentCardIndex = Math.min(cardIndex, starredCardsQueue.length - 1);
    if (starredCardsQueue.length === 0) {
      endStarredReview();
      return;
    }
    // Update progress display and show next card
    updateProgressDisplay();
    displayStarredCard(false);
    showToast("Card unstarred - removed from review queue", 1500);
    saveCard(card);
    return;
  }

  saveCard(card);
  showToast(card.starred ? "Card starred" : "Card unstarred", 1000);
}

function updateStarButton(isStarred) {
  var starButton = document.getElementById("starButton");
  if (!starButton) return;

  if (isStarred) {
    starButton.innerHTML = "&#9733;";
    starButton.classList.add("starred");
  } else {
    starButton.innerHTML = "&#9734;";
    starButton.classList.remove("starred");
  }
}

// Toggle showing only starred cards
function toggleStarredFilter() {
  // Start cross-deck starred review mode
  if (inStarredReviewMode) {
    endStarredReview();
    return;
  }

  var allStarred = getAllStarredCards();
  if (allStarred.length === 0) {
    showToast("No starred cards found", 2000);
    return;
  }

  showingStarredOnly = true;
  starredCardsQueue = allStarred;
  inStarredReviewMode = true;
  currentCardIndex = 0;

  var starredFilterBtn = document.getElementById("starredFilterBtn");
  if (starredFilterBtn) {
    starredFilterBtn.classList.add("active");
  }

  showToast("Reviewing " + allStarred.length + " starred cards", 2000);

  var statusElement = document.getElementById("statusMessage");
  statusElement.textContent = "Starred Cards Review";
  statusElement.style.display = "block";

  displayStarredCard(false);

  saveDeck();
}

function updateCardStats(card) {
  var statsElement = document.getElementById("cardStats");
  if (!statsElement || !card) return;

  var totalViews = card.timesViewed || 0;
  var correctAnswers = 0;
  var incorrectAnswers = 0;
  var lastViewed = card.lastViewed ? new Date(card.lastViewed) : null;

  if (card.history && card.history.length > 0) {
    for (var i = 0; i < card.history.length; i++) {
      if (card.history[i].result === true) {
        correctAnswers++;
      } else {
        incorrectAnswers++;
      }
    }
  }

  var lastViewedText = "never";
  if (lastViewed) {
    var now = new Date();
    var diffMs = now - lastViewed;
    var diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    var diffHours = Math.floor(diffMs / (1000 * 60 * 60)) % 24;
    var diffMins = Math.floor(diffMs / (1000 * 60)) % 60;

    if (diffDays > 0) {
      lastViewedText = diffDays + " day" + (diffDays !== 1 ? "s" : "") + " ago";
    } else if (diffHours > 0) {
      lastViewedText = diffHours + " hour" + (diffHours !== 1 ? "s" : "") + " ago";
    } else if (diffMins > 0) {
      lastViewedText = diffMins + " minute" + (diffMins !== 1 ? "s" : "") + " ago";
    } else {
      lastViewedText = "just now";
    }
  }

  statsElement.innerHTML = "Viewed " + totalViews + " time" + (totalViews !== 1 ? "s" : "") +
    " \u2022 Last: " + lastViewedText;
}

// Detect device and set appropriate scaling
function detectDeviceAndSetScaling() {
  var width = window.innerWidth || document.documentElement.clientWidth || document.body.clientWidth;
  var height = window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight;

  log("Device resolution detected: " + width + "x" + height);

  deviceScaleFactor = 1.0;

  if ((width >= 1070 && width <= 1080) && (height >= 1440 && height <= 1460)) {
    deviceScaleFactor = 0.6;
    log("Kindle Paperwhite 3 detected. Applied special scaling: " + deviceScaleFactor);
  }
  else if (width >= 1000 && height >= 1400) {
    deviceScaleFactor = 0.65;
    log("High-res device detected. Applied scaling: " + deviceScaleFactor);
  }
  else if ((width >= 750 && width < 1000) || (height >= 1000 && height < 1400)) {
    deviceScaleFactor = 0.8;
    log("Mid-size device detected. Applied scaling: " + deviceScaleFactor);
  }

  document.documentElement.style.fontSize = (deviceScaleFactor * 100) + "%";
  document.documentElement.style.setProperty('--device-scale', deviceScaleFactor);

  var body = document.body;
  body.classList.remove('kindle-base', 'kindle-paperwhite', 'kindle-oasis');

  if ((width >= 1070 && width <= 1080) && (height >= 1440 && height <= 1460)) {
    body.classList.add('kindle-paperwhite');
  } else if (width >= 1200) {
    body.classList.add('kindle-oasis');
  } else {
    body.classList.add('kindle-base');
  }
}

// ─── Deck Overview ─────────────────────────────────────────────────────────────

function showDeckOverview() {
  currentScreen = 'overview';

  var overviewEl   = document.getElementById("deckOverview");
  var browseEl     = document.getElementById("browseContainer");
  var manageEl     = document.getElementById("manageContainer");
  var mainEl       = document.getElementById("mainContainer");
  var headerEl     = document.getElementById("headerBar");
  var reviewEl     = document.getElementById("reviewScreen");

  if (reviewEl)  reviewEl.style.display  = "none";
  if (mainEl)    mainEl.style.display    = "block";
  if (headerEl)  headerEl.style.display  = "block";
  if (browseEl)  browseEl.style.display  = "none";
  if (manageEl)  manageEl.style.display  = "none";
  if (overviewEl) overviewEl.style.display = "block";

  renderOverviewStats();
}

function hideDeckOverview() {
  var overviewEl = document.getElementById("deckOverview");
  if (overviewEl) overviewEl.style.display = "none";
}

function renderOverviewStats() {
  var now = new Date().getTime();
  var total = deck.cards.length;
  var dueCount = 0;
  var newCount = 0;
  var suspendedCount = 0;
  var levelStats = {};

  for (var i = 0; i < deck.cards.length; i++) {
    var card = deck.cards[i];
    var lvl = card.level || appLevels[0];
    if (!levelStats[lvl]) levelStats[lvl] = { due: 0, total: 0 };
    levelStats[lvl].total++;

    if (card.suspended) {
      suspendedCount++;
      continue;
    }
    if (!card.timesViewed) newCount++;
    if (card.nextReview <= now) {
      dueCount++;
      levelStats[lvl].due++;
    }
  }

  var titleEl = document.getElementById("overviewDeckTitle");
  if (titleEl) titleEl.textContent = deck.name || "Flashcards";

  var totalEl = document.getElementById("overviewTotal");
  if (totalEl) totalEl.textContent = total;

  var dueEl = document.getElementById("overviewDue");
  if (dueEl) dueEl.textContent = dueCount;

  var newEl = document.getElementById("overviewNew");
  if (newEl) newEl.textContent = newCount;

  var suspEl = document.getElementById("overviewSuspended");
  if (suspEl) suspEl.textContent = suspendedCount;

  var levelsEl = document.getElementById("overviewLevels");
  if (levelsEl) {
    var html = '<table class="overviewLevelTable">';
    for (var k = 0; k < appLevels.length; k++) {
      var lvlKey = appLevels[k];
      var stats = levelStats[lvlKey] || { due: 0, total: 0 };
      var displayLvl = truncateLevel(lvlKey);
      html += '<tr class="overviewLevelRow">' +
              '<td class="overviewLevelName"><a href="#" onclick="navigateToDeck(\'' + lvlKey + '\'); return false;">' + displayLvl + '</a></td>' +
              '<td class="overviewLevelStats">' + stats.due + ' due / ' + stats.total + ' total</td>' +
              '</tr>';
    }
    html += '</table>';
    levelsEl.innerHTML = html;
  }
}

function startStudy() {
  currentScreen = 'review';

  var mainEl   = document.getElementById("mainContainer");
  var headerEl = document.getElementById("headerBar");
  var reviewEl = document.getElementById("reviewScreen");

  if (mainEl)   mainEl.style.display   = "none";
  if (headerEl) headerEl.style.display = "none";
  if (reviewEl) reviewEl.style.display = "block";

  // Compute the due list once at session start (like Anki's CardQueues).
  // This stable reference is used throughout the session to prevent card-jump.
  currentSessionDueCards = getDueCards();

  // Reset card scroll position
  var cardEl = document.getElementById("cardContainer");
  if (cardEl) cardEl.scrollTop = 0;

  currentCardIndex = 0;
  incorrectCardsQueue = [];
  displayCurrentCard(currentSessionDueCards, false);
}

// Navigate to a specific deck/level and start studying
function navigateToDeck(level) {
  currentLevel = level;
  currentCardIndex = 0;

  inErrorReviewMode = false;
  inStarredReviewMode = false;
  incorrectCardsQueue = [];
  starredCardsQueue = [];
  showingStarredOnly = false;

  var starredFilterBtn = document.getElementById("starredFilterBtn");
  if (starredFilterBtn) {
    starredFilterBtn.classList.remove("active");
  }

  showToast("Navigating to " + level, 1500);

  startStudy();
}

// ─── Browse Screen (read-only) ─────────────────────────────────────────────────

function showBrowseScreen() {
  currentScreen = 'browse';
  browseCurrentPage = 0;
  browseFilterLevel = 'all';

  var overviewEl = document.getElementById("deckOverview");
  var browseEl   = document.getElementById("browseContainer");
  var manageEl   = document.getElementById("manageContainer");

  if (overviewEl) overviewEl.style.display = "none";
  if (manageEl)   manageEl.style.display   = "none";
  if (browseEl)   browseEl.style.display   = "block";

  renderBrowseLevelFilter();
  renderBrowseCardList();
}

function hideBrowseScreen() {
  var browseEl = document.getElementById("browseContainer");
  if (browseEl) browseEl.style.display = "none";
  showDeckOverview();
}

function getBrowseCards() {
  var result = [];
  for (var i = 0; i < deck.cards.length; i++) {
    var card = deck.cards[i];
    if (browseFilterLevel !== 'all' && card.level !== browseFilterLevel) continue;
    result.push({ card: card, deckIndex: i });
  }
  return result;
}

function renderBrowseLevelFilter() {
  var el = document.getElementById("browseLevelFilter");
  if (!el) return;
  var html = '<button class="browseLevelBtn' + (browseFilterLevel === 'all' ? ' active' : '') +
             '" onclick="setBrowseLevel(\'all\')">All</button>';
  for (var i = 0; i < appLevels.length; i++) {
    var lvl = appLevels[i];
    var displayLvl = truncateLevel(lvl);
    html += '<button class="browseLevelBtn' + (browseFilterLevel === lvl ? ' active' : '') +
            '" onclick="setBrowseLevel(\'' + lvl + '\')">' + displayLvl + '</button>';
  }
  el.innerHTML = html;
}

function setBrowseLevel(level) {
  browseFilterLevel = level;
  browseCurrentPage = 0;
  renderBrowseLevelFilter();
  renderBrowseCardList();
}

function renderBrowseCardList() {
  var filtered = getBrowseCards();
  var total    = filtered.length;
  var start    = browseCurrentPage * CARDS_PER_PAGE;
  var end      = Math.min(start + CARDS_PER_PAGE, total);
  var pageItems = filtered.slice(start, end);

  var statsEl = document.getElementById("browseStats");
  if (statsEl) statsEl.textContent = total + " cards";

  var listEl = document.getElementById("browseCardList");
  if (!listEl) return;

  var html = '';
  for (var i = 0; i < pageItems.length; i++) {
    html += renderBrowseCardItem(pageItems[i].card);
  }
  listEl.innerHTML = html;

  renderBrowsePagination(total);
}

function renderBrowseCardItem(card) {
  var isSuspended = card.suspended === true;
  var isStarred   = card.starred === true;
  var isIO        = card.type === 'image-occlusion';

  var itemClass = 'browseCardItem';
  if (isSuspended) itemClass += ' suspended';

  var suspBadge = isSuspended ? ' <span class="suspendedIndicator">[susp]</span>' : '';
  var starBadge = isStarred   ? ' <span class="starBadge">&#9733;</span>' : '';

  var tagHtml = '';
  if (card.tags && card.tags.length > 0) {
    for (var t = 0; t < card.tags.length; t++) {
      tagHtml += '<span class="tagBadge">' + card.tags[t] + '</span>';
    }
  }

  var frontText = isIO ? '[Image Occlusion]' : (card.front || '');
  var backText  = isIO ? (card.front || '')  : (card.back  || '');

  return '<div class="' + itemClass + '">' +
    '<div class="browseCardHeader">' +
      '<span class="browseCardLevel">' + (card.level || '') + '</span>' +
      suspBadge + starBadge +
    '</div>' +
    '<div class="browseCardFront">' + frontText + '</div>' +
    '<div class="browseCardBack">' + backText + '</div>' +
    (tagHtml ? '<div class="browseCardTags">' + tagHtml + '</div>' : '') +
  '</div>';
}

function browsePrevPage() {
  if (browseCurrentPage > 0) {
    browseCurrentPage--;
    renderBrowseCardList();
  }
}

function browseNextPage() {
  var total   = getBrowseCards().length;
  var maxPage = Math.ceil(total / CARDS_PER_PAGE) - 1;
  if (browseCurrentPage < maxPage) {
    browseCurrentPage++;
    renderBrowseCardList();
  }
}

function renderBrowsePagination(total) {
  var el = document.getElementById("browsePagination");
  if (!el) return;
  var totalPages     = Math.max(1, Math.ceil(total / CARDS_PER_PAGE));
  var currentPageNum = browseCurrentPage + 1;
  var html = '<button onclick="browsePrevPage()"' + (browseCurrentPage === 0 ? ' disabled' : '') + '>&#9664; Prev</button>';
  html += '<span class="currentPage">Page ' + currentPageNum + ' / ' + totalPages + '</span>';
  html += '<button onclick="browseNextPage()"' + (currentPageNum >= totalPages ? ' disabled' : '') + '>Next &#9654;</button>';
  el.innerHTML = html;
}

// ─── Manage Screen (selection / tagging) ──────────────────────────────────────

function showManageScreen() {
  currentScreen = 'manage';
  manageCurrentPage = 0;
  manageSelectedIndices = [];
  manageFilterLevel = 'all';

  var overviewEl = document.getElementById("deckOverview");
  var browseEl   = document.getElementById("browseContainer");
  var manageEl   = document.getElementById("manageContainer");

  if (overviewEl) overviewEl.style.display = "none";
  if (browseEl)   browseEl.style.display   = "none";
  if (manageEl)   manageEl.style.display   = "block";

  renderManageLevelFilter();
  renderManageCardList();
  updateManageControls();
}

function hideManageScreen() {
  var manageEl = document.getElementById("manageContainer");
  if (manageEl) manageEl.style.display = "none";
  showDeckOverview();
}

function getManageCards() {
  var result = [];
  for (var i = 0; i < deck.cards.length; i++) {
    var card = deck.cards[i];
    if (manageFilterLevel !== 'all' && card.level !== manageFilterLevel) continue;
    result.push({ card: card, deckIndex: i });
  }
  return result;
}

function renderManageLevelFilter() {
  var el = document.getElementById("manageLevelFilter");
  if (!el) return;
  var html = '<button class="browseLevelBtn' + (manageFilterLevel === 'all' ? ' active' : '') +
             '" onclick="setManageLevel(\'all\')">All</button>';
  for (var i = 0; i < appLevels.length; i++) {
    var lvl = appLevels[i];
    var displayLvl = truncateLevel(lvl);
    html += '<button class="browseLevelBtn' + (manageFilterLevel === lvl ? ' active' : '') +
            '" onclick="setManageLevel(\'' + lvl + '\')">' + displayLvl + '</button>';
  }
  el.innerHTML = html;
}

function setManageLevel(level) {
  manageFilterLevel = level;
  manageCurrentPage = 0;
  manageSelectedIndices = [];
  renderManageLevelFilter();
  renderManageCardList();
  updateManageControls();
}

function renderManageCardList() {
  var filtered = getManageCards();
  var total    = filtered.length;
  var start    = manageCurrentPage * CARDS_PER_PAGE;
  var end      = Math.min(start + CARDS_PER_PAGE, total);
  var pageItems = filtered.slice(start, end);

  var statsEl = document.getElementById("manageStats");
  if (statsEl) statsEl.textContent = total + " cards";

  var listEl = document.getElementById("manageCardList");
  if (!listEl) return;

  var html = '';
  for (var i = 0; i < pageItems.length; i++) {
    html += renderManageCardItem(pageItems[i].card, start + i);
  }
  listEl.innerHTML = html;

  renderManagePagination(total);
}

function renderManageCardItem(card, manageIdx) {
  var isSelected  = manageSelectedIndices.indexOf(manageIdx) !== -1;
  var isSuspended = card.suspended === true;
  var isStarred   = card.starred === true;
  var isIO        = card.type === 'image-occlusion';

  var itemClass = 'browseCardItem';
  if (isSelected)  itemClass += ' selected';
  if (isSuspended) itemClass += ' suspended';

  var checkbox  = isSelected ? '&#9745;' : '&#9744;';
  var suspBadge = isSuspended ? ' <span class="suspendedIndicator">[susp]</span>' : '';
  var starBadge = isStarred   ? ' <span class="starBadge">&#9733;</span>' : '';

  var tagHtml = '';
  if (card.tags && card.tags.length > 0) {
    for (var t = 0; t < card.tags.length; t++) {
      tagHtml += '<span class="tagBadge">' + card.tags[t] + '</span>';
    }
  }

  var frontText = isIO ? '[Image Occlusion]' : (card.front || '');
  var backText  = isIO ? (card.front || '')  : (card.back  || '');

  return '<div class="' + itemClass + '" onclick="toggleManageCardSelection(' + manageIdx + ')">' +
    '<div class="browseCardHeader">' +
      '<span class="browseCardCheckbox">' + checkbox + '</span>' +
      '<span class="browseCardLevel">' + (card.level || '') + '</span>' +
      suspBadge + starBadge +
    '</div>' +
    '<div class="browseCardFront">' + frontText + '</div>' +
    '<div class="browseCardBack">' + backText + '</div>' +
    (tagHtml ? '<div class="browseCardTags">' + tagHtml + '</div>' : '') +
  '</div>';
}

function toggleManageCardSelection(manageIdx) {
  var pos = manageSelectedIndices.indexOf(manageIdx);
  if (pos === -1) {
    manageSelectedIndices.push(manageIdx);
  } else {
    manageSelectedIndices.splice(pos, 1);
  }
  renderManageCardList();
  updateManageControls();
}

function selectAllManageCards() {
  var filtered = getManageCards();
  var start = manageCurrentPage * CARDS_PER_PAGE;
  var end   = Math.min(start + CARDS_PER_PAGE, filtered.length);
  for (var i = start; i < end; i++) {
    if (manageSelectedIndices.indexOf(i) === -1) {
      manageSelectedIndices.push(i);
    }
  }
  renderManageCardList();
  updateManageControls();
}

function deselectAllManageCards() {
  manageSelectedIndices = [];
  renderManageCardList();
  updateManageControls();
}

function toggleSuspendSelected() {
  if (manageSelectedIndices.length === 0) return;
  var filtered = getManageCards();

  var hasUnsuspended = false;
  for (var i = 0; i < manageSelectedIndices.length; i++) {
    var idx = manageSelectedIndices[i];
    if (idx < filtered.length && !filtered[idx].card.suspended) {
      hasUnsuspended = true;
      break;
    }
  }
  for (var i = 0; i < manageSelectedIndices.length; i++) {
    var idx = manageSelectedIndices[i];
    if (idx < filtered.length) {
      filtered[idx].card.suspended = hasUnsuspended;
    }
  }
  saveDeck();
  renderManageCardList();
  updateManageControls();
  showToast(hasUnsuspended ? "Cards suspended" : "Cards unsuspended", 1500);
}

function addTagToSelected() {
  if (manageSelectedIndices.length === 0) return;
  var filtered = getManageCards();

  var existingTags = [];
  for (var i = 0; i < deck.cards.length; i++) {
    var tags = deck.cards[i].tags || [];
    for (var t = 0; t < tags.length; t++) {
      if (existingTags.indexOf(tags[t]) === -1) existingTags.push(tags[t]);
    }
  }

  var hint = existingTags.length > 0 ? " (existing: " + existingTags.join(", ") + ")" : "";
  var tag = prompt("Enter tag to add" + hint + ":");
  if (!tag || tag.trim() === "") return;
  tag = tag.trim();

  for (var i = 0; i < manageSelectedIndices.length; i++) {
    var idx = manageSelectedIndices[i];
    if (idx < filtered.length) {
      var card = filtered[idx].card;
      if (!card.tags) card.tags = [];
      if (card.tags.indexOf(tag) === -1) card.tags.push(tag);
    }
  }
  saveDeck();
  renderManageCardList();
  showToast('Tag "' + tag + '" added', 1500);
}

function removeTagFromSelected() {
  if (manageSelectedIndices.length === 0) return;
  var filtered = getManageCards();

  var tag = prompt("Enter tag to remove:");
  if (!tag || tag.trim() === "") return;
  tag = tag.trim();

  for (var i = 0; i < manageSelectedIndices.length; i++) {
    var idx = manageSelectedIndices[i];
    if (idx < filtered.length) {
      var card = filtered[idx].card;
      if (card.tags) {
        card.tags = card.tags.filter(function(t) { return t !== tag; });
      }
    }
  }
  saveDeck();
  renderManageCardList();
  showToast('Tag "' + tag + '" removed', 1500);
}

function managePrevPage() {
  if (manageCurrentPage > 0) {
    manageCurrentPage--;
    manageSelectedIndices = [];
    renderManageCardList();
    updateManageControls();
  }
}

function manageNextPage() {
  var total   = getManageCards().length;
  var maxPage = Math.ceil(total / CARDS_PER_PAGE) - 1;
  if (manageCurrentPage < maxPage) {
    manageCurrentPage++;
    manageSelectedIndices = [];
    renderManageCardList();
    updateManageControls();
  }
}

function updateManageControls() {
  var count        = manageSelectedIndices.length;
  var suspendBtn   = document.getElementById("suspendBtn");
  var unsuspendBtn = document.getElementById("unsuspendBtn");
  var addTagBtn    = document.getElementById("addTagBtn");
  var removeTagBtn = document.getElementById("removeTagBtn");

  if (count === 0) {
    if (suspendBtn)   suspendBtn.style.display   = "none";
    if (unsuspendBtn) unsuspendBtn.style.display = "none";
    if (addTagBtn)    addTagBtn.style.display    = "none";
    if (removeTagBtn) removeTagBtn.style.display = "none";
    return;
  }

  var filtered = getManageCards();
  var allSuspended = true;
  for (var i = 0; i < count; i++) {
    var idx = manageSelectedIndices[i];
    if (idx < filtered.length && !filtered[idx].card.suspended) {
      allSuspended = false;
      break;
    }
  }

  if (suspendBtn)   suspendBtn.style.display   = allSuspended ? "none" : "";
  if (unsuspendBtn) unsuspendBtn.style.display = allSuspended ? "" : "none";
  if (addTagBtn)    addTagBtn.style.display    = "";
  if (removeTagBtn) removeTagBtn.style.display = "";
}

function renderManagePagination(total) {
  var el = document.getElementById("managePagination");
  if (!el) return;
  var totalPages     = Math.max(1, Math.ceil(total / CARDS_PER_PAGE));
  var currentPageNum = manageCurrentPage + 1;
  var html = '<button onclick="managePrevPage()"' + (manageCurrentPage === 0 ? ' disabled' : '') + '>&#9664; Prev</button>';
  html += '<span class="currentPage">Page ' + currentPageNum + ' / ' + totalPages + '</span>';
  html += '<button onclick="manageNextPage()"' + (currentPageNum >= totalPages ? ' disabled' : '') + '>Next &#9654;</button>';
  el.innerHTML = html;
}

// ─── Options Screen ─────────────────────────────────────────────────────────────

function onOptionsPageLoad() {
  log("Options page loading...");
  loadSchedConfig();
  populateOptionsForm();
}

function populateOptionsForm() {
  if (!SCHED_CONFIG) return;
  var el = function(id) { return document.getElementById(id); };
  if (el('optNewPerDay')) el('optNewPerDay').value = SCHED_CONFIG.newPerDay;
  if (el('optReviewsPerDay')) el('optReviewsPerDay').value = SCHED_CONFIG.reviewsPerDay;
  if (el('optLearnSteps')) el('optLearnSteps').value = SCHED_CONFIG.learnSteps.join(', ');
  if (el('optRelearnSteps')) el('optRelearnSteps').value = SCHED_CONFIG.relearnSteps.join(', ');
  if (el('optGraduatingInterval')) el('optGraduatingInterval').value = SCHED_CONFIG.graduatingIntervalGood;
  if (el('optEasyInterval')) el('optEasyInterval').value = SCHED_CONFIG.graduatingIntervalEasy;
  if (el('optInitialEase')) el('optInitialEase').value = SCHED_CONFIG.initialEase;
  if (el('optEasyMultiplier')) el('optEasyMultiplier').value = SCHED_CONFIG.easyMultiplier;
  if (el('optHardMultiplier')) el('optHardMultiplier').value = SCHED_CONFIG.hardMultiplier;
  if (el('optMaxInterval')) el('optMaxInterval').value = SCHED_CONFIG.maximumReviewInterval;
  if (el('optAgainStep')) el('optAgainStep').value = SCHED_CONFIG.learnSteps[0] || 10;
}

function readOptionsForm() {
  var el = function(id) { return document.getElementById(id); };
  var val = function(id) { return parseFloat(el(id).value) || 0; };
  var valStr = function(id) { return el(id).value.trim(); };

  SCHED_CONFIG.newPerDay = Math.max(1, Math.min(999, val('optNewPerDay')));
  SCHED_CONFIG.reviewsPerDay = Math.max(1, Math.min(9999, val('optReviewsPerDay')));

  // Parse comma-separated step lists
  var parseSteps = function(str) {
    var parts = str.split(',').map(function(s) { return parseInt(s.trim(), 10); });
    return parts.filter(function(n) { return !isNaN(n) && n > 0; });
  };
  SCHED_CONFIG.learnSteps = parseSteps(valStr('optLearnSteps'));
  if (SCHED_CONFIG.learnSteps.length === 0) SCHED_CONFIG.learnSteps = [1, 10];
  SCHED_CONFIG.relearnSteps = parseSteps(valStr('optRelearnSteps'));
  if (SCHED_CONFIG.relearnSteps.length === 0) SCHED_CONFIG.relearnSteps = [10];

  SCHED_CONFIG.graduatingIntervalGood = Math.max(1, Math.min(365, val('optGraduatingInterval')));
  SCHED_CONFIG.graduatingIntervalEasy = Math.max(1, Math.min(3650, val('optEasyInterval')));
  SCHED_CONFIG.initialEase = Math.max(1.3, Math.min(5, val('optInitialEase')));
  SCHED_CONFIG.easyMultiplier = Math.max(1.0, Math.min(3, val('optEasyMultiplier')));
  SCHED_CONFIG.hardMultiplier = Math.max(1.0, Math.min(3, val('optHardMultiplier')));
  SCHED_CONFIG.maximumReviewInterval = Math.max(1, Math.min(99999, val('optMaxInterval')));
  SCHED_CONFIG.learnSteps[0] = Math.max(1, Math.min(1440, Math.round(val('optAgainStep'))));
}

function saveOptions() {
  readOptionsForm();
  saveSchedConfig();
  log("Options saved: " + JSON.stringify(SCHED_CONFIG));
  showToast("Options saved", 800);
  setTimeout(function() { window.location.href = 'index.html'; }, 800);
}

function applyPreset(name) {
  if (!schedPresets[name]) return;
  var preset = schedPresets[name];
  var el = function(id) { return document.getElementById(id); };

  // Apply preset values
  SCHED_CONFIG.newPerDay = preset.newPerDay;
  SCHED_CONFIG.reviewsPerDay = preset.reviewsPerDay;
  SCHED_CONFIG.learnSteps = preset.learnSteps.slice();
  SCHED_CONFIG.relearnSteps = preset.relearnSteps.slice();
  SCHED_CONFIG.graduatingIntervalGood = preset.graduatingIntervalGood;
  SCHED_CONFIG.graduatingIntervalEasy = preset.graduatingIntervalEasy;
  SCHED_CONFIG.initialEase = preset.initialEase;
  SCHED_CONFIG.easyMultiplier = preset.easyMultiplier;
  SCHED_CONFIG.hardMultiplier = preset.hardMultiplier;
  SCHED_CONFIG.maximumReviewInterval = preset.maximumReviewInterval;
  // Also apply defaults for fields not in preset
  for (var key in defaultSchedConfig) {
    if (!(key in preset)) {
      SCHED_CONFIG[key] = defaultSchedConfig[key];
    }
  }

  currentPresetName = name;
  populateOptionsForm();
  log("Applied preset: " + name);
}

function toggleInfoTooltip() {
  var tooltip = document.getElementById("optionsTooltip");
  if (tooltip) {
    tooltip.style.display = tooltip.style.display === "none" ? "flex" : "none";
  }
}

// Close tooltip on outside click
document.addEventListener('click', function(e) {
  var tooltip = document.getElementById("optionsTooltip");
  if (tooltip && tooltip.style.display === "flex") {
    var infoBtn = document.getElementById("optionsInfoBtn");
    if (e.target !== tooltip && !tooltip.contains(e.target) && e.target !== infoBtn) {
      tooltip.style.display = "none";
    }
  }
});

// Switch between tabs (currently only Basic exists)
function switchTab(tabName) {
  var tabs = document.querySelectorAll('.optionsTab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.remove('active');
  }
  var contents = document.querySelectorAll('.tabContent');
  for (var i = 0; i < contents.length; i++) {
    contents[i].classList.remove('active');
  }

  if (tabName === 'basic') {
    document.getElementById('tabBasic').classList.add('active');
    document.getElementById('tabBasicContent').classList.add('active');
  }
}

// ── Logs Panel ─────────────────────────────────────────────────

var logsBuffer = [];
var logsBufferMax = 500;

function toggleLogsPanel() {
  var panel = document.getElementById("logsPanel");
  if (!panel) return;

  if (panel.style.display === "none") {
    // Populate logs from localStorage (persisted across pages)
    var logsContent = document.getElementById("logsContent");
    if (logsContent) {
      logsContent.innerHTML = "";
      try {
        var stored = localStorage.getItem("kanki_logs");
        var allLogs = stored ? JSON.parse(stored) : [];
        // Also include in-memory buffer
        allLogs = allLogs.concat(logsBuffer);
        // Show last 500 entries, newest at bottom
        if (allLogs.length > logsBufferMax) {
          allLogs = allLogs.slice(allLogs.length - logsBufferMax);
        }
        for (var i = 0; i < allLogs.length; i++) {
          var p = document.createElement("p");
          p.textContent = allLogs[i];
          logsContent.appendChild(p);
        }
      } catch (e) {
        // Corrupted log data — show in-memory buffer only
        for (var i = 0; i < logsBuffer.length; i++) {
          var p = document.createElement("p");
          p.textContent = logsBuffer[i];
          logsContent.appendChild(p);
        }
      }
      // Scroll to bottom (tail)
      logsContent.scrollTop = logsContent.scrollHeight;
    }
    panel.style.display = "flex";
  } else {
    panel.style.display = "none";
  }
}

// Override the global log function to also persist to localStorage
(function() {
  var origLog = log;
  log = function(logStuff) {
    var logEntry = "[" + new Date().toLocaleTimeString() + "] " + logStuff;
    logsBuffer.push(logEntry);
    if (logsBuffer.length > logsBufferMax) {
      logsBuffer = logsBuffer.slice(logsBuffer.length - logsBufferMax);
    }
    // Persist to localStorage for cross-page visibility
    try {
      var stored = localStorage.getItem("kanki_logs");
      var allLogs = stored ? JSON.parse(stored) : [];
      allLogs.push(logEntry);
      // Cap total stored logs
      if (allLogs.length > logsBufferMax * 3) {
        allLogs = allLogs.slice(allLogs.length - logsBufferMax * 3);
      }
      localStorage.setItem("kanki_logs", JSON.stringify(allLogs));
    } catch (e) {
      // localStorage full — ignore
    }
    origLog(logStuff);
  };
})();
