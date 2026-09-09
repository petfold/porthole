// Minimal typings for the Generic Sensor API (not in lib.dom).
interface SensorOptions { frequency?: number }
interface OrientationSensorOptions extends SensorOptions { referenceFrame?: 'device' | 'screen' }
declare class Sensor extends EventTarget {
  readonly activated: boolean;
  readonly hasReading: boolean;
  readonly timestamp: number | null;
  start(): void;
  stop(): void;
  onreading: ((this: Sensor, ev: Event) => unknown) | null;
  onerror: ((this: Sensor, ev: Event & { error: DOMException }) => unknown) | null;
  onactivate: ((this: Sensor, ev: Event) => unknown) | null;
}
declare class OrientationSensor extends Sensor {
  readonly quaternion: [number, number, number, number] | null;
}
declare class RelativeOrientationSensor extends OrientationSensor {
  constructor(options?: OrientationSensorOptions);
}
declare class AbsoluteOrientationSensor extends OrientationSensor {
  constructor(options?: OrientationSensorOptions);
}
declare class Accelerometer extends Sensor {
  constructor(options?: SensorOptions);
  readonly x: number | null; readonly y: number | null; readonly z: number | null;
}
declare class LinearAccelerationSensor extends Accelerometer {
  constructor(options?: SensorOptions);
}
declare class Gyroscope extends Sensor {
  constructor(options?: SensorOptions);
  readonly x: number | null; readonly y: number | null; readonly z: number | null;
}
