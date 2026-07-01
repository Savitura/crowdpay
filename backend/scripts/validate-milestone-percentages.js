#!/usr/bin/env node

/**
 * Validation script to identify campaigns with milestone percentages exceeding 100%
 * Run with: node scripts/validate-milestone-percentages.js
 */

const db = require('../src/config/database');

async function validateMilestonePercentages() {
  console.log('Validating milestone percentage totals...\n');
  
  try {
    // Query to find campaigns with milestone percentages exceeding 100%
    const query = `
      WITH milestone_totals AS (
        SELECT 
          c.id AS campaign_id,
          c.title AS campaign_title,
          c.status AS campaign_status,
          COUNT(m.id) AS milestone_count,
          SUM(m.release_percentage) AS total_percentage,
          STRING_AGG(m.title || ' (' || m.release_percentage || '%)', ', ' ORDER BY m.sort_order) AS milestone_details
        FROM campaigns c
        LEFT JOIN milestones m ON m.campaign_id = c.id
        WHERE c.deleted_at IS NULL
        GROUP BY c.id, c.title, c.status
        HAVING COUNT(m.id) > 0
      )
      SELECT 
        campaign_id,
        campaign_title,
        milestone_count,
        total_percentage,
        campaign_status,
        milestone_details,
        (total_percentage > 100.001) AS exceeds_100_percent
      FROM milestone_totals
      ORDER BY exceeds_100_percent DESC, total_percentage DESC
    `;
    
    const { rows } = await db.query(query);
    
    const invalidCampaigns = rows.filter(row => row.exceeds_100_percent);
    const validCampaigns = rows.filter(row => !row.exceeds_100_percent);
    
    console.log(`Found ${rows.length} campaigns with milestones`);
    console.log(`- ${invalidCampaigns.length} campaigns exceed 100% total`);
    console.log(`- ${validCampaigns.length} campaigns have valid percentages (<= 100%)\n`);
    
    if (invalidCampaigns.length > 0) {
      console.log('⚠️  Campaigns with invalid milestone percentages (exceeding 100%):');
      console.log('='.repeat(80));
      invalidCampaigns.forEach((campaign, index) => {
        console.log(`\n${index + 1}. ${campaign.campaign_title} (ID: ${campaign.campaign_id})`);
        console.log(`   Status: ${campaign.campaign_status}`);
        console.log(`   Total percentage: ${campaign.total_percentage}%`);
        console.log(`   Milestones (${campaign.milestone_count}): ${campaign.milestone_details}`);
      });
      console.log('\n' + '='.repeat(80));
      console.log('\n⚠️  These campaigns may cause Soroban contract execution to panic!');
      console.log('   Consider updating milestone percentages or contacting campaign creators.');
    }
    
    // Show summary of valid campaigns with high percentages
    const highPercentageCampaigns = validCampaigns
      .filter(row => row.total_percentage > 99 && row.total_percentage <= 100)
      .sort((a, b) => b.total_percentage - a.total_percentage);
    
    if (highPercentageCampaigns.length > 0) {
      console.log('\n📊 Campaigns with high but valid percentages (99%-100%):');
      highPercentageCampaigns.slice(0, 10).forEach((campaign, index) => {
        console.log(`${index + 1}. ${campaign.campaign_title}: ${campaign.total_percentage}%`);
      });
      if (highPercentageCampaigns.length > 10) {
        console.log(`... and ${highPercentageCampaigns.length - 10} more`);
      }
    }
    
    return { invalidCampaigns, validCampaigns };
    
  } catch (error) {
    console.error('Error validating milestone percentages:', error.message);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  validateMilestonePercentages()
    .then(() => {
      console.log('\n✅ Validation complete');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n❌ Validation failed:', error.message);
      process.exit(1);
    });
}

module.exports = { validateMilestonePercentages };