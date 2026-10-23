import {defineConfig} from '@playwright/test';
import base from './playwright.native-capture.config';
export default defineConfig(base,{testMatch:'native-pipeline.spec.ts',outputDir:'test-results/native-pipeline',reporter:[['line'],['json',{outputFile:'test-results/native-pipeline/results.json'}]]});