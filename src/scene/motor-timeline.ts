// Presentation parameters, not a calibrated electromagnetic solver.
export const MOTOR_DURATION = 40;
export const MOTOR_SLOWDOWN = 80;
export const ASSEMBLY_WINDOWS: Record<string, [number, number]> = {
  im_stator: [2, 4], im_rotor: [4, 6], im_jacket: [6, 8], im_housing: [8, 10],
  im_front: [10, 12], im_resolver: [11, 13], im_gears: [12, 14],
  im_rear: [14, 16], im_heat: [15, 17], im_inverter: [15, 17],
};
export const smooth = (x: number) => { x = Math.max(0, Math.min(1, x)); return x*x*(3-2*x); };
export function assemblyProgress(part: string, time: number) {
  const window = ASSEMBLY_WINDOWS[part]; return window ? smooth((time-window[0])/(window[1]-window[0])) : 0;
}
export function motorSample(time: number) {
  const t = Math.max(0, Math.min(MOTOR_DURATION, time)), start = Math.max(0, t-23), u = Math.min(1, start/6);
  const fieldRpm = t >= 23 ? 1500 : 0, rotorRpm = 1440*smooth(u);
  // Integral of smoothstep gives continuous angular position and acceleration.
  const rotorTurns = 1440/60/MOTOR_SLOWDOWN*(6*(u*u*u-u*u*u*u/2)+Math.max(0,start-6));
  const fieldTurns = 1500/60/MOTOR_SLOWDOWN*start;
  const stage = t < 2 ? '01 / 零件展开' : t < 17 ? '02 / 同轴装配' : t < 19 ? '03 / 装配完成' : t < 23 ? '04 / 机理剖视' : t < 29 ? '05 / 通电启动' : '06 / 稳态运行';
  const detail = t < 2 ? '鼠笼转子 · 三相绕组 · 水套 · 铸铝壳体' : t < 17 ? '定子、转子、水套与端盖按顺序归位' : t < 19 ? '端盖与主壳合拢，逆变器落位' : t < 23 ? '移除观察侧半壳，保留完整转子' : t < 29 ? '三相电流建立旋转磁场，鼠笼转子逐渐加速' : '定子静止；转子与轴同转，持续落后于旋转磁场';
  return { time:t, stage, detail, fieldRpm, rotorRpm, slip:fieldRpm ? (fieldRpm-rotorRpm)/fieldRpm*100 : null, rotorAngle:rotorTurns*Math.PI*2, fieldAngle:fieldTurns*Math.PI*2, cut:smooth((t-19)/3), energized:t>=23 };
}
export type MotorSample = ReturnType<typeof motorSample>;
