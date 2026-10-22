'use strict';

// Gentle driving. BB-8's inner cart leans to accelerate and the magnetic head leans with it, so a
// sudden start, stop or change of direction knocks the head off vertical (or off the robot).
// Instead of jumping to the joystick position, the sent position moves toward it a little each tick.
// A reversal therefore slows down through zero before speeding up the other way, and a sharp turn
// eases off a bit while the heading swings round.

// Largest change of the joystick vector per 100 ms tick: rest to full speed takes about 0.8 s.
const SMOOTH_STEP = 0.12;

function easeJoystick(current, target, step = SMOOTH_STEP) {
  const dx = target[0] - current[0];
  const dy = target[1] - current[1];
  const distance = Math.hypot(dx, dy);
  if (distance <= step) return [target[0], target[1]];
  return [current[0] + dx / distance * step, current[1] + dy / distance * step];
}

if (typeof module !== 'undefined') module.exports = { SMOOTH_STEP, easeJoystick };
