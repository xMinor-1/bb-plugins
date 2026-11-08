"""Sample Word and PowerPoint files for the conversion check: Cyrillic text, a table, two slides.

    python make-docs.py <folder>
"""
import os
import sys

from docx import Document
from pptx import Presentation

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

doc = Document()
doc.add_heading("Проверка просмотра документов", level=1)
doc.add_paragraph("Text with Cyrillic: съешь же ещё этих мягких французских булок.")
table = doc.add_table(rows=2, cols=2)
table.cell(0, 0).text = "Metric"
table.cell(0, 1).text = "Value"
table.cell(1, 0).text = "Рейсы"
table.cell(1, 1).text = "42"
doc.save(os.path.join(out, "документ.docx"))

deck = Presentation()
for title in ("First slide", "Второй слайд"):
    slide = deck.slides.add_slide(deck.slide_layouts[1])
    slide.shapes.title.text = title
    slide.placeholders[1].text = "Slide text"
deck.save(os.path.join(out, "слайды.pptx"))
print("docs:", len(os.listdir(out)))
