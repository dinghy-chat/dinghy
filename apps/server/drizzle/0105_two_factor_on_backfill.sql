-- The operators who turned two-step sign-in on before the flag existed.
UPDATE operator SET two_factor_on = true
WHERE id IN (SELECT operator_id FROM operator_two_factor WHERE enabled_at IS NOT NULL);
