import {defineConfig} from '@playwright/test';
import base from './playwright.native-capture.config';
export default defineConfig(base,{testMatch:'native-stress.spec.ts',outputDir:'test-results/native-stress',reporter:[['line'],['json',{outputFile:'test-results/native-stress/results.json'}]]});