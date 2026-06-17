/**
 * src/utils/metrics-registry.ts
 *
 * Single shared prom-client Registry.
 *
 * Why a separate file?
 * prom-client throws "A metric with that name has already been registered"
 * if the same Counter/Histogram is registered twice on the default Registry
 * (common during Jest test runs or hot-reload).  Exporting `register` from
 * one canonical module and passing it explicitly to every metric constructor
 * prevents that.
 *
 * Usage:
 *   import { register } from './metrics-registry'
 *   // then pass `registers: [register]` to every new Counter / Histogram
 *
 * The existing getMetrics() in utils/metrics.ts should call:
 *   return register.metrics()
 * instead of
 *   return promClient.register.metrics()
 *
 * (They are the same object — this file just exports it explicitly.)
 */

import { register } from 'prom-client';

export { register };