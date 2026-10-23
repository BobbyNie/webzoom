import {defineConfig} from '@playwright/test';
import capacity from './playwright.capacity.config';
export default defineConfig(capacity,{
 testMatch:'soak.spec.ts',outputDir:'test-results/relay-soak',
 reporter:[['line'],['json',{outputFile:'test-results/relay-soak/results.json'}]],
});
