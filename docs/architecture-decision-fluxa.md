# Architecture Decision Record: CrowdPay Payment Stack & Fluxa Relationship

**Issue Reference**: #1007  
**Date**: October 2026  
**Status**: Accepted  
**Decision**: Option 2 — Keep CrowdPay standalone and describe Fluxa as a separate, later product.

---

## 1. Context & Problem Statement

The CrowdPay repository previously referred to **Fluxa** as "the payment infrastructure layer" (README line 302). However, a comprehensive audit of the CrowdPay codebase revealed:
- CrowdPay does not import, invoke, or configure Fluxa anywhere in its frontend, backend, or smart contracts.
- CrowdPay already implements a complete, native payment and settlement stack:
  - `stellarService.js`: Account activation, trustlines, custodial key management, Horizon monitoring.
  - `sorobanService.js`: Smart contract bindings for campaigns, milestones, treasury, and escrow.
  - `anchorService.js`: SEP-10 authentication and SEP-24 interactive deposits.
  - `reconciliation.js` & `ledgerMonitor.js`: Transaction ingestion and double-entry reconciliation.
  - `kycProvider.js` & `webhookDispatcher.js`: Identity verification and event streaming.

Maintaining statements that CrowdPay "runs on Fluxa" while running a fully native stack causes confusion for Stellar Community Fund (SCF) evaluators, audit engineers, and open-source contributors.

---

## 2. Considered Options

1. **Wire one real flow through Fluxa and extract that code from CrowdPay**:
   - *Downside*: Fluxa is under independent development and not yet published as a stable npm package or deployed service with parity for CrowdPay's custom multi-sig and milestone release rules. Introducing an unversioned external dependency would destabilize CrowdPay's testnet deployment.
2. **Keep CrowdPay standalone and describe Fluxa as a separate, later product (CHOSEN)**:
   - *Rationale*: Reflects the true architectural state of the repository. Preserves the security perimeter of CrowdPay's audited contracts and single unified codebase. Leaves a clean upgrade path for future modular adoption once Fluxa matures.
3. **Fold the useful Fluxa pieces into CrowdPay and park Fluxa**:
   - *Downside*: Deprecates Fluxa prematurely and bloats the CrowdPay repository with payment infrastructure concerns outside the scope of crowdfunding.

---

## 3. Decision Outcome

CrowdPay remains **fully standalone**:
- All payment, wallet, escrow, and anchor capabilities are maintained directly in CrowdPay.
- The README and documentation explicitly state that CrowdPay runs on its own native Stellar/Soroban implementation.
- Fluxa is documented as Savitura's standalone payment infrastructure layer, targeted for cross-application reuse in future development phases.
- SCF proposal text and grant deliverables will align with this architecture, avoiding claims of dual-stack dependencies.
