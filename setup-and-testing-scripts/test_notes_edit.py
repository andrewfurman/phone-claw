"""Offline tests for line-level Apple Notes edits in mac-tools/notes (#150). No Mac or Notes app needed.
Run: python3 setup-and-testing-scripts/test_notes_edit.py"""
import importlib.machinery, importlib.util, pathlib, unittest
path = pathlib.Path(__file__).resolve().parents[1] / "mac-tools" / "notes"
loader = importlib.machinery.SourceFileLoader("notes_cli", str(path))
spec = importlib.util.spec_from_loader("notes_cli", loader); notes = importlib.util.module_from_spec(spec); loader.exec_module(notes)

TJ = ('<div><b><font face=".AppleSystemUIFontBold"><span style="font-size: 24px">Trader Joe’s </span></font></b></div>\n'
      '<div>Updated Monday, October 5</div>\n<div><br></div>\n'
      '<div>- Berries (strawberries, blueberries, raspberries, blackberries)</div>\n<div>- Sparkling water</div>\n'
      '<ul>\n<li>Vegetable: baby corn</li>\n<li>Sprinkles tomatoes </li>\n</ul>\n')

def edit(*args): return notes.parse(["edit", "18", *args])

class Parse(unittest.TestCase):
    def test_exactly_one_op(self):
        for bad in ([], ["--add", "x", "--remove", "y"], ["--replace", "x"], ["--with", "y"], ["--add", "x", "--title", "t"], ["oops"], ["--add", "a\nb"], ["--add", "x" * 201]):
            with self.assertRaises(ValueError, msg=bad): edit(*bad)
        with self.assertRaises(ValueError): notes.parse(["edit", "abc", "--add", "x"])
        with self.assertRaises(ValueError): notes.parse(["create", "--line", "x"])
        with self.assertRaises(ValueError): notes.parse(["create", "--title", "t", "--add", "x"])
        self.assertEqual(edit("--remove", "milk", "--dry-run")["op"], "remove")
        self.assertEqual(edit("--add", "eggs", "--add", "bread")["add"], ["eggs", "bread"])

class Apply(unittest.TestCase):
    def test_add_goes_into_trailing_list_and_keeps_everything_else(self):
        new, change = notes.apply_edit(TJ, edit("--add", "Eggs & bread"))
        self.assertIn("<li>Sprinkles tomatoes </li>\n<li>Eggs &amp; bread</li></ul>", new)
        self.assertTrue(new.startswith(TJ.split("<li>Sprinkles")[0]))
        self.assertEqual(change, {"added": ["Eggs & bread"]})

    def test_add_matches_dash_style_when_no_trailing_list(self):
        body = '<div><h1>Costco</h1></div><div>- Milk</div><div>- Eggs</div><div><br></div>'
        new, _ = notes.apply_edit(body, edit("--add", "Paper towels"))
        self.assertEqual(new, '<div><h1>Costco</h1></div><div>- Milk</div><div>- Eggs</div><div>- Paper towels</div><div><br></div>')

    def test_remove_exact_ignoring_dash_and_case(self):
        new, change = notes.apply_edit(TJ, edit("--remove", "sparkling WATER"))
        self.assertNotIn("Sparkling water", new); self.assertIn("- Berries", new); self.assertEqual(change["removed"], "- Sparkling water")

    def test_remove_last_list_item_drops_empty_list(self):
        body = '<div><h1>T</h1></div><ul><li>Only</li></ul>'
        new, _ = notes.apply_edit(body, edit("--remove", "only"))
        self.assertEqual(new, '<div><h1>T</h1></div>')

    def test_unique_partial_match_and_ambiguity(self):
        new, change = notes.apply_edit(TJ, edit("--replace", "baby corn", "--with", "Vegetable: snap peas"))
        self.assertIn("<li>Vegetable: snap peas</li>", new); self.assertEqual(change["replaced"], "Vegetable: baby corn")
        _, change = notes.apply_edit(TJ, edit("--remove", "berries"))
        self.assertTrue(change["removed"].startswith("- Berries"))
        body = '<div><h1>T</h1></div><div>- Red apples</div><div>- Green apples</div>'
        with self.assertRaises(LookupError) as e: notes.apply_edit(body, edit("--remove", "apples"))
        self.assertEqual(e.exception.args[0], "ambiguous_line")
        with self.assertRaises(LookupError) as e: notes.apply_edit(body, edit("--remove", "pears"))
        self.assertEqual(e.exception.args[0], "line_not_found")

    def test_replace_keeps_dash_prefix_and_escapes(self):
        new, change = notes.apply_edit(TJ, edit("--replace", "sparkling water", "--with", "Lime <seltzer>"))
        self.assertIn("<div>- Lime &lt;seltzer&gt;</div>", new); self.assertEqual(change["with"], "- Lime <seltzer>")

    def test_title_is_never_matched(self):
        with self.assertRaises(LookupError): notes.apply_edit(TJ, edit("--remove", "Trader Joe’s"))

if __name__ == "__main__":
    unittest.main(verbosity=1)
