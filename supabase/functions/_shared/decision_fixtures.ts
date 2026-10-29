/**
 * Fixtures for decision_test.ts – copied from ../TRACK-3-ehds/requests/
 * CI has no access to the TRACK-3-ehds directory, so the data lives here.
 */

import type { HealthDataRequest } from "./decision.ts";

export interface ExpectedDecision {
  decision: "REJECT" | "APPROVE_STATISTICAL" | "APPROVE_SPE";
  articles: string[];
}

// ---------------------------------------------------------------------------
// The 10 requests (R01–R10)
// ---------------------------------------------------------------------------
export const REQUESTS: Record<string, HealthDataRequest> = {
  R01: {
    id: "R01",
    requested_as: "health data request",
    requested_format: "anonymised statistics",
    purpose:
      "We study regional differences in type 2 diabetes to plan a prevention programme with the regional health authorities.",
    question:
      "How many adults have type 2 diabetes in each region and what is the prevalence?",
  },
  R02: {
    id: "R02",
    requested_as: "health data request",
    requested_format: "anonymised statistics",
    purpose:
      "We want to align private health insurance premiums for customers with diabetes with their actual risk.",
    question:
      "What is the average HbA1c of adults with type 2 diabetes by 10-year age band?",
  },
  R03: {
    id: "R03",
    requested_as: "health data request",
    requested_format: "anonymised statistics",
    purpose:
      "Guidelines recommend oral anticoagulation for most older patients with atrial fibrillation. We want to know how large the treatment gap is to plan a quality programme.",
    question:
      "Among patients with atrial fibrillation aged 65 and over, how many have no active oral anticoagulant, by age band?",
  },
  R04: {
    id: "R04",
    requested_as: "health data request",
    requested_format: "anonymised statistics",
    purpose:
      "Our client launches a new SGLT2 inhibitor. We want to focus our physician advertising campaign on the regions where these drugs are already prescribed most.",
    question: "How many patients have an active SGLT2 inhibitor prescription, by region?",
  },
  R05: {
    id: "R05",
    requested_as: "health data access application",
    requested_format: "pseudonymised records",
    purpose:
      "We train and validate a model that predicts which patients with type 2 diabetes will have an HbA1c above 8% in the next 12 months, so that GPs can intervene earlier. Training needs individual-level histories; aggregates are not enough.",
    question:
      "Provide pseudonymised conditions, medications and HbA1c values for adults with type 2 diabetes who have at least one HbA1c value. We will only export model weights and performance metrics.",
  },
  R06: {
    id: "R06",
    requested_as: "health data access application",
    requested_format: "pseudonymised records",
    purpose:
      "We want to reduce sick leave. We will match the records with our employee list to see who has been diagnosed with depression before we renew contracts.",
    question: "Provide records of all adults with a depression diagnosis in OberAsterreich.",
  },
  R07: {
    id: "R07",
    requested_as: "health data request",
    requested_format: "anonymised statistics",
    purpose: "Official statistics on hospital use for the annual health report.",
    question: "How many inpatient stays started in 2025, by the patient's region?",
  },
  R08: {
    id: "R08",
    requested_as: "health data request",
    requested_format: "anonymised statistics",
    purpose: "Research on body weight as a risk factor in breast cancer, to inform prevention advice.",
    question: "What is the mean BMI of women with breast cancer, by region?",
  },
  R09: {
    id: "R09",
    requested_as: "health data access application",
    requested_format: "pseudonymised records",
    purpose:
      "We want to compare how often ACE inhibitors and angiotensin receptor blockers are used for hypertension in different age groups, to update a teaching module for GPs.",
    question: "Provide pseudonymised records of all adults with hypertension and their medications.",
  },
  R10: {
    id: "R10",
    requested_as: "health data request",
    requested_format: "anonymised statistics",
    purpose:
      "We are developing new nicotine pouch flavours and want to know which age groups and regions have the most smokers' lung disease, to position the products as a 'healthier alternative'.",
    question: "How many patients have COPD, by 10-year age band and region?",
  },
};

// ---------------------------------------------------------------------------
// Expected outcomes (from expected.json)
// ---------------------------------------------------------------------------
export const EXPECTED: Record<string, ExpectedDecision> = {
  R01: { decision: "APPROVE_STATISTICAL", articles: ["53", "69"] },
  R02: { decision: "REJECT", articles: ["54"] },
  R03: { decision: "APPROVE_STATISTICAL", articles: ["53", "69"] },
  R04: { decision: "REJECT", articles: ["54"] },
  R05: { decision: "APPROVE_SPE", articles: ["53", "66", "68", "73"] },
  R06: { decision: "REJECT", articles: ["54"] },
  R07: { decision: "APPROVE_STATISTICAL", articles: ["53", "69"] },
  R08: { decision: "APPROVE_STATISTICAL", articles: ["53", "69"] },
  R09: { decision: "APPROVE_STATISTICAL", articles: ["53", "66", "69"] },
  R10: { decision: "REJECT", articles: ["54"] },
};
