import {defineConfig} from '@playwright/test';
import lan from './playwright.lan.config';
// Windows-only, explicitly provisioned temporary native-host test; not part of the mock suite.
export default defineConfig({...lan,testMatch:'native.integration.ts',outputDir:'../artifacts/native-playwright'});
