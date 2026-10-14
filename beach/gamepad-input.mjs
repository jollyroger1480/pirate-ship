const NEUTRAL = Object.freeze({
  steer: 0,
  throttle: 0,
  cameraX: 0,
  cameraY: 0,
  zoom: 0,
  connected: false,
  id: "",
});

function clamp(value, min = -1, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function finiteAxis(axes, index) {
  const value = axes?.[index];
  return Number.isFinite(value) ? clamp(value) : 0;
}

function buttonValue(buttons, index) {
  const button = buttons?.[index];
  if (typeof button === "number") return Number.isFinite(button) ? clamp(button, 0, 1) : 0;
  return button && Number.isFinite(button.value) ? clamp(button.value, 0, 1) : 0;
}

// Apply a circular deadzone, then rescale the remaining stick travel to 0..1.
function radialDeadzone(x, y, deadzone) {
  const magnitude = Math.hypot(x, y);
  if (!Number.isFinite(magnitude) || magnitude <= deadzone) return [0, 0];
  const scaledMagnitude = Math.min(1, (magnitude - deadzone) / (1 - deadzone));
  const scale = scaledMagnitude / magnitude;
  return [clamp(x * scale), clamp(y * scale)];
}

/**
 * Read one Gamepad API object. Standard mapping: left stick axes 0/1,
 * right stick axes 2/3, left/right triggers buttons 6/7, and shoulder
 * buttons 4/5 for zoom out/in. Unknown mappings are reported as connected
 * but kept neutral rather than guessing at device-specific layouts.
 */
export function readGamepadInput(gamepad, deadzone = 0.18) {
  if (!gamepad || gamepad.connected !== true) return { ...NEUTRAL };

  const id = typeof gamepad.id === "string" ? gamepad.id : "";
  const neutral = { ...NEUTRAL, connected: true, id };
  if (gamepad.mapping !== "standard") return neutral;

  const dz = Number.isFinite(deadzone) ? clamp(deadzone, 0, 0.99) : 0.18;
  const [leftX] = radialDeadzone(
    finiteAxis(gamepad.axes, 0),
    finiteAxis(gamepad.axes, 1),
    dz
  );
  const [rightX, rightY] = radialDeadzone(
    finiteAxis(gamepad.axes, 2),
    finiteAxis(gamepad.axes, 3),
    dz
  );

  return {
    // Gamepad X increases to the right; helm steer increases to the left.
    steer: leftX === 0 ? 0 : -leftX,
    // Standard trigger 7 accelerates and trigger 6 reverses.
    throttle: buttonValue(gamepad.buttons, 7) - buttonValue(gamepad.buttons, 6),
    cameraX: rightX,
    cameraY: rightY,
    // Standard shoulder buttons 4/5 provide digital zoom out/in.
    zoom: buttonValue(gamepad.buttons, 5) - buttonValue(gamepad.buttons, 4),
    connected: true,
    id,
  };
}

/**
 * Combine pad analog values with keyboard directions. A pressed key owns its
 * axis (including opposing keys, which cancel to neutral); otherwise the pad
 * value passes through. Directional booleans remain available to legacy helm
 * consumers, while steer/throttle expose the combined continuous controls.
 */
export function mergeInputs(keys, padInput) {
  const keyboard = keys || {};
  const pad = padInput || NEUTRAL;
  const left = keyboard.left === true;
  const right = keyboard.right === true;
  const forward = keyboard.forward === true;
  const back = keyboard.back === true;
  const keySteer = (left ? 1 : 0) - (right ? 1 : 0);
  const keyThrottle = (forward ? 1 : 0) - (back ? 1 : 0);

  return {
    left,
    right,
    forward,
    back,
    steer: left || right ? keySteer : (Number.isFinite(pad.steer) ? clamp(pad.steer) : 0),
    throttle: forward || back
      ? keyThrottle
      : (Number.isFinite(pad.throttle) ? clamp(pad.throttle) : 0),
    cameraX: Number.isFinite(pad.cameraX) ? clamp(pad.cameraX) : 0,
    cameraY: Number.isFinite(pad.cameraY) ? clamp(pad.cameraY) : 0,
    zoom: Number.isFinite(pad.zoom) ? clamp(pad.zoom) : 0,
    connected: pad.connected === true,
    id: typeof pad.id === "string" ? pad.id : "",
  };
}
