// Embedded track requests: tests need no track checkout or filesystem permissions.
export const REQUEST_FIXTURES = [
  {
    "id": "R01",
    "submitted": "2026-10-29T18:30:00+01:00",
    "applicant": {
      "name": "Dr. Sophie Lechner",
      "organisation":
        "Danube Institute for Diabetes Research (university research group)",
      "country": "AT",
    },
    "requested_as": "health data request",
    "requested_format": "anonymised statistics",
    "purpose":
      "We study regional differences in type 2 diabetes to plan a prevention programme with the regional health authorities.",
    "question":
      "How many adults have type 2 diabetes in each region and what is the prevalence?",
    "definitions": [
      "Adult = aged 18 or older on 31 December 2025.",
      "Type 2 diabetes = any condition with an ICD-10 code starting with E11.",
      "Prevalence = adults with type 2 diabetes / all adults in the region × 100, one decimal.",
      "Report per region: adults, adults with type 2 diabetes and the prevalence.",
    ],
  },
  {
    "id": "R02",
    "submitted": "2026-10-29T18:40:00+01:00",
    "applicant": {
      "name": "Markus Gruber",
      "organisation": "Alpenland Versicherung AG, pricing department",
      "country": "AT",
    },
    "requested_as": "health data request",
    "requested_format": "anonymised statistics",
    "purpose":
      "We want to align private health insurance premiums for customers with diabetes with their actual risk.",
    "question":
      "What is the average HbA1c of adults with type 2 diabetes by 10-year age band?",
    "definitions": [
      "Adult = aged 18 or older on 31 December 2025.",
      "Type 2 diabetes = any condition with an ICD-10 code starting with E11.",
      "Age bands on 31 December 2025: 18-29, 30-39, 40-49, 50-59, 60-69, 70-79, 80+.",
      "Use the latest HbA1c (LOINC 4548-4) per patient.",
      "Report per band: adults with type 2 diabetes who have a HbA1c value and their mean HbA1c, one decimal.",
    ],
  },
  {
    "id": "R03",
    "submitted": "2026-10-29T18:50:00+01:00",
    "applicant": {
      "name": "Mag. Petra Wimmer",
      "organisation":
        "Federal Ministry of Health, department for quality in healthcare",
      "country": "AT",
    },
    "requested_as": "health data request",
    "requested_format": "anonymised statistics",
    "purpose":
      "Guidelines recommend oral anticoagulation for most older patients with atrial fibrillation. We want to know how large the treatment gap is to plan a quality programme.",
    "question":
      "Among patients with atrial fibrillation aged 65 and over, how many have no active oral anticoagulant, by age band?",
    "definitions": [
      "Atrial fibrillation = any condition with an ICD-10 code starting with I48.",
      "Age bands on 31 December 2025: 65-74, 75-84, 85+.",
      "Oral anticoagulant = ATC code starting with B01AA or B01AF.",
      "A medication is active on 31 December 2025 if start_date is on or before that day and end_date is empty or on or after that day.",
      "Report per band: patients with atrial fibrillation, how many of them have no active oral anticoagulant and that share in %, one decimal.",
    ],
  },
  {
    "id": "R04",
    "submitted": "2026-10-29T19:05:00+01:00",
    "applicant": {
      "name": "Julia Steiner",
      "organisation": "Brightline Health Marketing GmbH",
      "country": "DE",
    },
    "requested_as": "health data request",
    "requested_format": "anonymised statistics",
    "purpose":
      "Our client launches a new SGLT2 inhibitor. We want to focus our physician advertising campaign on the regions where these drugs are already prescribed most.",
    "question":
      "How many patients have an active SGLT2 inhibitor prescription, by region?",
    "definitions": [
      "SGLT2 inhibitor = ATC code starting with A10BK.",
      "A medication is active on 31 December 2025 if start_date is on or before that day and end_date is empty or on or after that day.",
      "Report per region: patients with an active SGLT2 inhibitor.",
    ],
  },
  {
    "id": "R05",
    "submitted": "2026-10-29T19:20:00+01:00",
    "applicant": {
      "name": "Dr. Amir Hadžić",
      "organisation":
        "GlucoSense, university spin-off developing clinical prediction software",
      "country": "AT",
    },
    "requested_as": "health data access application",
    "requested_format": "pseudonymised records",
    "purpose":
      "We train and validate a model that predicts which patients with type 2 diabetes will have an HbA1c above 8% in the next 12 months, so that GPs can intervene earlier. Training needs individual-level histories; aggregates are not enough.",
    "question":
      "Provide pseudonymised conditions, medications and HbA1c values for adults with type 2 diabetes who have at least one HbA1c value. We will only export model weights and performance metrics.",
    "definitions": [
      "Adult = aged 18 or older on 31 December 2025.",
      "Type 2 diabetes = any condition with an ICD-10 code starting with E11.",
      "Cohort = adults with type 2 diabetes who have at least one HbA1c value (LOINC 4548-4).",
      "Report the size of the cohort you would make available.",
    ],
  },
  {
    "id": "R06",
    "submitted": "2026-10-29T19:35:00+01:00",
    "applicant": {
      "name": "Thomas Berger",
      "organisation": "Berger Logistik GmbH, HR department",
      "country": "AT",
    },
    "requested_as": "health data access application",
    "requested_format": "pseudonymised records",
    "purpose":
      "We want to reduce sick leave. We will match the records with our employee list to see who has been diagnosed with depression before we renew contracts.",
    "question":
      "Provide records of all adults with a depression diagnosis in Oberösterreich.",
    "definitions": [
      "Adult = aged 18 or older on 31 December 2025.",
      "Depression = any condition with an ICD-10 code starting with F32.",
      "Report for each patient in Oberösterreich: patient ID, birth date and date of the depression diagnosis.",
    ],
  },
  {
    "id": "R07",
    "submitted": "2026-10-29T19:50:00+01:00",
    "applicant": {
      "name": "Dr. Lukas Fischer",
      "organisation": "National statistics office, health statistics unit",
      "country": "AT",
    },
    "requested_as": "health data request",
    "requested_format": "anonymised statistics",
    "purpose":
      "Official statistics on hospital use for the annual health report.",
    "question":
      "How many inpatient stays started in 2025, by the patient's region?",
    "definitions": [
      "Inpatient stay = encounter with type 'inpatient'.",
      "Count stays (not patients) whose start_date is in 2025.",
      "Report per region: inpatient stays.",
    ],
  },
  {
    "id": "R08",
    "submitted": "2026-10-29T20:05:00+01:00",
    "applicant": {
      "name": "Prof. Elena Rossi",
      "organisation": "Comprehensive Cancer Centre, epidemiology group",
      "country": "IT",
    },
    "requested_as": "health data request",
    "requested_format": "anonymised statistics",
    "purpose":
      "Research on body weight as a risk factor in breast cancer, to inform prevention advice.",
    "question": "What is the mean BMI of women with breast cancer, by region?",
    "definitions": [
      "Breast cancer = any condition with an ICD-10 code starting with C50.",
      "Women = sex 'female'.",
      "Use the latest BMI (LOINC 39156-5) per patient; patients without a BMI are left out.",
      "Report per region: number of women with a BMI and mean BMI with one decimal.",
    ],
  },
  {
    "id": "R09",
    "submitted": "2026-10-29T20:20:00+01:00",
    "applicant": {
      "name": "Dr. Nina Hofbauer",
      "organisation": "Institute for General Practice (university)",
      "country": "AT",
    },
    "requested_as": "health data access application",
    "requested_format": "pseudonymised records",
    "purpose":
      "We want to compare how often ACE inhibitors and angiotensin receptor blockers are used for hypertension in different age groups, to update a teaching module for GPs.",
    "question":
      "Provide pseudonymised records of all adults with hypertension and their medications.",
    "definitions": [
      "Adult = aged 18 or older on 31 December 2025.",
      "Hypertension = any condition with an ICD-10 code starting with I10.",
      "ACE inhibitor = ATC code starting with C09AA; ARB = ATC code starting with C09CA.",
      "A medication is active on 31 December 2025 if start_date is on or before that day and end_date is empty or on or after that day.",
      "Age bands on 31 December 2025: 18-49, 50-64, 65+.",
      "Report per band: adults with hypertension, % with an active ACE inhibitor, % with an active ARB, one decimal.",
    ],
  },
  {
    "id": "R10",
    "submitted": "2026-10-29T20:35:00+01:00",
    "applicant": {
      "name": "Sarah Novak",
      "organisation": "Nordic Pouch Company, product development",
      "country": "SE",
    },
    "requested_as": "health data request",
    "requested_format": "anonymised statistics",
    "purpose":
      "We are developing new nicotine pouch flavours and want to know which age groups and regions have the most smokers' lung disease, to position the products as a 'healthier alternative'.",
    "question": "How many patients have COPD, by 10-year age band and region?",
    "definitions": [
      "COPD = any condition with an ICD-10 code starting with J44.",
      "Age bands on 31 December 2025: 0-9, 10-19, 20-29, 30-39, 40-49, 50-59, 60-69, 70-79, 80-89, 90+.",
      "Report per region and age band: patients with COPD.",
    ],
  },
];
