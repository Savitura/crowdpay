use crate::calculate_match_amount;

#[test]
fn match_amount_uses_one_to_one_ratio() {
    assert_eq!(calculate_match_amount(1_000, 100, 10_000), 1_000);
}

#[test]
fn match_amount_uses_two_to_one_ratio() {
    assert_eq!(calculate_match_amount(1_000, 200, 10_000), 2_000);
}

#[test]
fn match_amount_rounds_down_to_asset_precision() {
    assert_eq!(calculate_match_amount(101, 50, 10_000), 50);
}

#[test]
fn match_amount_is_capped_by_remaining_pool() {
    assert_eq!(calculate_match_amount(1_000, 200, 500), 500);
}

#[test]
fn match_amount_is_zero_when_pool_is_empty() {
    assert_eq!(calculate_match_amount(1_000, 100, 0), 0);
}

#[test]
fn match_amount_is_zero_for_zero_contribution() {
    assert_eq!(calculate_match_amount(0, 200, 10_000), 0);
}

#[test]
fn match_amount_at_exact_pool_boundary() {
    assert_eq!(calculate_match_amount(500, 100, 500), 500);
}
