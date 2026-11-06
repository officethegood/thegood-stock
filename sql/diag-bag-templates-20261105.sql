-- diag-bag-templates-20261105.sql — READ-ONLY. One query, run the whole file.
-- Which bag uses which template, and how many items each template really has.
SELECT l.code AS bag_code, l.name AS bag_name,
       bt.code AS template_code, bt.name AS template_name, bt.active AS template_active,
       (SELECT count(*) FROM bag_template_items i WHERE i.bag_template_id = bt.id) AS items,
       (SELECT count(*) FROM bag_template_items i WHERE i.bag_template_id = bt.id AND i.mandatory) AS mandatory_items,
       bt.created_at::date AS template_created, bt.updated_at::date AS template_updated
FROM   locations l
LEFT   JOIN bag_templates bt ON bt.id = l.bag_template_id
WHERE  l.type = 'bag'
UNION ALL
SELECT '(ไม่มีกระเป๋าใช้)', NULL, bt.code, bt.name, bt.active,
       (SELECT count(*) FROM bag_template_items i WHERE i.bag_template_id = bt.id),
       (SELECT count(*) FROM bag_template_items i WHERE i.bag_template_id = bt.id AND i.mandatory),
       bt.created_at::date, bt.updated_at::date
FROM   bag_templates bt
WHERE  NOT EXISTS (SELECT 1 FROM locations l WHERE l.bag_template_id = bt.id)
ORDER  BY 1;
