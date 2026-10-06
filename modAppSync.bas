Attribute VB_Name = "modAppSync"
'===========================================================
'  modAppSync - round trip between Asset_Record.xlsm and the
'  "Asset Record" Android app.
'
'  ImportFromApp        : phone ZIP (Location.csv, Asset.csv, photos\)
'                         -> appends to Location A:Q / Asset A:AS
'  ExportMasterForApp   : workbook -> master JSON the app imports
'                         (Sync -> Import master data)
'
'  Import rules (same checks as SaveLocationRow / CMD_SAVE_ASSET_Click):
'   - Location skipped if FLCode exists (col A) or LocationCodeFinal
'     exists (col O) or parent FL not found.
'   - Asset skipped if Etag exists (col A) or FuncLoc not in Location A.
'   - New Manufacturer/Model/Received From/Unit -> Class&Units AI/AJ/S/O
'     (SaveComboValues).
'   - Photos copied to APP_IMAGE_FOLDER as <Etag>.jpg + "File" hyperlink
'     in Asset!AQ (AddImageHyperlink).
'   - Every row's result is written to sheet "AppImportLog".
'===========================================================
Option Explicit

' Same folder AddImageHyperlink (Module3) uses. Change both together.
Private Const APP_IMAGE_FOLDER As String = _
    "C:\Users\AjeshValsalan\OneDrive - FPO\Pictures\Asset Image\"

Private Const LOC_COLS As Long = 17      ' A:Q
Private Const ASSET_COLS As Long = 45    ' A:AS

Private mLog As Worksheet
Private mLogRow As Long

'===========================================================
'  IMPORT
'===========================================================
Public Sub ImportFromApp()

    Dim zipPath As Variant
    Dim tmp As String
    Dim locRows As Collection, assetRows As Collection, chgRows As Collection
    Dim nChgOk As Long, nChgSkip As Long
    Dim nLocOk As Long, nLocSkip As Long, nAssOk As Long, nAssSkip As Long, nPhotos As Long

    zipPath = Application.GetOpenFilename("Asset app export (*.zip),*.zip", , "Select the ZIP exported from the app")
    If VarType(zipPath) = vbBoolean Then Exit Sub

    On Error GoTo ErrHandler

    tmp = Environ$("TEMP") & "\AssetAppImport_" & Format$(Now, "yyyymmdd_hhnnss") & "\"
    MkDir tmp
    UnzipTo CStr(zipPath), tmp

    If Dir(tmp & "Location.csv") = "" Or Dir(tmp & "Asset.csv") = "" Then
        MsgBox "Location.csv / Asset.csv not found in:" & vbCrLf & zipPath, vbExclamation
        Exit Sub
    End If

    Set locRows = ReadCsv(tmp & "Location.csv")
    Set assetRows = ReadCsv(tmp & "Asset.csv")
    If Dir(tmp & "Changes.csv") <> "" Then Set chgRows = ReadCsv(tmp & "Changes.csv") Else Set chgRows = New Collection

    Application.ScreenUpdating = False
    Application.EnableEvents = False

    StartLog CStr(zipPath)

    ImportLocations locRows, nLocOk, nLocSkip
    ImportAssets assetRows, tmp & "photos\", nAssOk, nAssSkip, nPhotos
    ImportChanges chgRows, nChgOk, nChgSkip

    ' Refresh the form's helper sheets exactly like after a manual save
    On Error Resume Next
    Application.Run "LoadFilteredLocation"
    Application.Run "LoadFilteredAsset"
    Application.Run "FormatAssetSheet"
    On Error GoTo ErrHandler

    Application.EnableEvents = True
    Application.ScreenUpdating = True

    MsgBox "App import finished." & vbCrLf & vbCrLf & _
           "Locations: " & nLocOk & " added, " & nLocSkip & " skipped" & vbCrLf & _
           "Assets: " & nAssOk & " added, " & nAssSkip & " skipped" & vbCrLf & _
           "Transfers/disposals: " & nChgOk & " applied, " & nChgSkip & " skipped" & vbCrLf & _
           "Photos copied: " & nPhotos & vbCrLf & vbCrLf & _
           "Details: sheet 'AppImportLog'." & vbCrLf & _
           "Then run ExportMasterForApp and import it on the phone.", _
           IIf(nLocSkip + nAssSkip + nChgSkip > 0, vbExclamation, vbInformation)
    Exit Sub

ErrHandler:
    Application.EnableEvents = True
    Application.ScreenUpdating = True
    MsgBox "App import error:" & vbCrLf & Err.Number & " - " & Err.Description, vbCritical
End Sub

Private Sub ImportLocations(csvRows As Collection, ByRef nOk As Long, ByRef nSkip As Long)

    Dim ws As Worksheet, wsF As Worksheet
    Dim i As Long, j As Long, r As Long
    Dim v As Variant
    Dim fl As String, finalCode As String, parentFl As String

    Set ws = ThisWorkbook.Sheets("Location")
    On Error Resume Next
    Set wsF = ThisWorkbook.Sheets("FilteredLocation")
    On Error GoTo 0

    ' rows(1) = header
    For i = 2 To csvRows.Count
        v = csvRows(i)
        fl = Trim$(Cell(v, 1))
        If fl = "" Then GoTo NextRow
        finalCode = Trim$(Cell(v, 15))
        parentFl = Trim$(Cell(v, 4))

        If ExistsInColumn(ws, "A", fl) Then
            LogLine "Location", fl, "SKIPPED", "FL Code already exists"
            nSkip = nSkip + 1: GoTo NextRow
        End If
        If ExistsInColumn(ws, "O", finalCode) Then
            LogLine "Location", fl, "CONFLICT", "LocationCodeFinal " & finalCode & _
                " already used in workbook. Re-create this location on the phone after refreshing master data."
            nSkip = nSkip + 1: GoTo NextRow
        End If
        If parentFl <> "F100001" And Not ExistsInColumn(ws, "A", parentFl) Then
            LogLine "Location", fl, "SKIPPED", "Parent FL not found: " & parentFl
            nSkip = nSkip + 1: GoTo NextRow
        End If

        r = ws.Cells(ws.Rows.Count, "A").End(xlUp).Row + 1
        For j = 1 To LOC_COLS
            ws.Cells(r, j).value = Cell(v, j)
        Next j
        ws.Cells(r, "G").value = ParseDmy(Cell(v, 7))          ' FLDate as real date
        ws.Cells(r, "G").NumberFormat = "dd.mm.yyyy"

        If Not wsF Is Nothing Then                              ' SaveLocationRow copies here too
            Dim rF As Long
            rF = wsF.Cells(wsF.Rows.Count, "A").End(xlUp).Row + 1
            wsF.Range("A" & rF & ":Q" & rF).value = ws.Range("A" & r & ":Q" & r).value
        End If

        LogLine "Location", fl, "ADDED", finalCode
        nOk = nOk + 1
NextRow:
    Next i
End Sub

Private Sub ImportAssets(csvRows As Collection, photoDir As String, ByRef nOk As Long, ByRef nSkip As Long, ByRef nPhotos As Long)

    Dim ws As Worksheet, wsLoc As Worksheet, wsC As Worksheet
    Dim i As Long, j As Long, r As Long
    Dim v As Variant
    Dim etag As String, fl As String

    Set ws = ThisWorkbook.Sheets("Asset")
    Set wsLoc = ThisWorkbook.Sheets("Location")
    Set wsC = ThisWorkbook.Sheets("Class&Units")

    For i = 2 To csvRows.Count
        v = csvRows(i)
        etag = Trim$(Cell(v, 1))
        If etag = "" Then GoTo NextRow
        fl = Trim$(Cell(v, 9))

        If ExistsInColumn(ws, "A", etag) Then
            LogLine "Asset", etag, "SKIPPED", "Etag already exists"
            nSkip = nSkip + 1: GoTo NextRow
        End If
        If Not ExistsInColumn(wsLoc, "A", fl) Then
            LogLine "Asset", etag, "SKIPPED", "FuncLoc not in Location sheet: " & fl
            nSkip = nSkip + 1: GoTo NextRow
        End If

        r = ws.Cells(ws.Rows.Count, "A").End(xlUp).Row + 1
        For j = 1 To ASSET_COLS
            ws.Cells(r, j).value = Cell(v, j)
        Next j
        ws.Cells(r, "AQ").ClearContents
        ' ChgOn (R) / CrtdOn (T) are real dates in WriteAssetDataToRow
        ws.Cells(r, "R").value = ParseDmy(Cell(v, 18)): ws.Cells(r, "R").NumberFormat = "dd.mm.yyyy"
        ws.Cells(r, "T").value = ParseDmy(Cell(v, 20)): ws.Cells(r, "T").NumberFormat = "dd.mm.yyyy"

        ' SaveComboValues equivalents
        AddIfMissing wsC, "AI", Cell(v, 3)
        AddIfMissing wsC, "AJ", Cell(v, 4)
        AddIfMissing wsC, "S", Cell(v, 8)
        AddIfMissing wsC, "O", Cell(v, 15)

        ' Photo -> image folder + hyperlink
        If Dir(photoDir & etag & ".jpg") <> "" Then
            On Error Resume Next
            If Dir(APP_IMAGE_FOLDER, vbDirectory) <> "" Then
                If Dir(APP_IMAGE_FOLDER & etag & ".*") = "" Then
                    FileCopy photoDir & etag & ".jpg", APP_IMAGE_FOLDER & etag & ".jpg"
                    If Err.Number = 0 Then nPhotos = nPhotos + 1
                End If
                Err.Clear
                Dim fName As String
                fName = Dir(APP_IMAGE_FOLDER & etag & ".*")
                If fName <> "" Then
                    ws.Hyperlinks.Add Anchor:=ws.Cells(r, "AQ"), Address:=APP_IMAGE_FOLDER & fName, TextToDisplay:="File"
                End If
            Else
                LogLine "Asset", etag, "WARNING", "Image folder not found: " & APP_IMAGE_FOLDER
            End If
            Err.Clear
            On Error GoTo 0
        End If

        LogLine "Asset", etag, "ADDED", Cell(v, 2) & " @ " & Cell(v, 10)
        nOk = nOk + 1
NextRow:
    Next i
End Sub

'===========================================================
'  Transfers (asset shifting) and disposals from Changes.csv
'  Columns: ChangeId, Type, EquipTagNo, Date, FromFuncLoc, FromCode,
'           ToFuncLoc, ToCode, Reason, Reference, Remarks, User, Recorded
'  TRANSFER: Asset I/J + FL1..FL6 codes (X:AC) and descriptions (AD:AI)
'            rebuilt like Update_FL_Desc_OneRow; Q/R = ChgBy/ChgOn
'  DISPOSE : Asset AO (Status) = "Disposed"; Q/R = ChgBy/ChgOn
'  Every change is written once to sheet AssetHistory (keyed on ChangeId).
'===========================================================
Private Sub ImportChanges(csvRows As Collection, ByRef nOk As Long, ByRef nSkip As Long)

    Dim ws As Worksheet, wsLoc As Worksheet, wsH As Worksheet
    Dim i As Long, k As Long, r As Variant, lr As Variant
    Dim v As Variant
    Dim cid As String, typ As String, etag As String, toFl As String, toCode As String
    Dim parts() As String, partial As String, dr As Variant

    If csvRows.Count < 2 Then Exit Sub
    Set ws = ThisWorkbook.Sheets("Asset")
    Set wsLoc = ThisWorkbook.Sheets("Location")
    Set wsH = HistorySheet()

    For i = 2 To csvRows.Count
        v = csvRows(i)
        cid = Trim$(Cell(v, 1)): typ = UCase$(Trim$(Cell(v, 2))): etag = Trim$(Cell(v, 3))
        If etag = "" Then GoTo NextRow

        If cid <> "" And ExistsInColumn(wsH, "B", cid) Then
            LogLine "Change", etag, "SKIPPED", typ & " " & cid & " was imported before"
            nSkip = nSkip + 1: GoTo NextRow
        End If
        r = Application.Match(etag, ws.Columns("A"), 0)
        If IsError(r) Then
            LogLine "Change", etag, "SKIPPED", typ & ": Etag not found in Asset sheet"
            nSkip = nSkip + 1: GoTo NextRow
        End If

        Select Case typ
        Case "TRANSFER"
            toFl = Trim$(Cell(v, 7))
            lr = Application.Match(toFl, wsLoc.Columns("A"), 0)
            If IsError(lr) Then
                LogLine "Change", etag, "SKIPPED", "Transfer: location " & toFl & " not in Location sheet"
                nSkip = nSkip + 1: GoTo NextRow
            End If
            toCode = CStr(wsLoc.Cells(CLng(lr), "O").value)
            ws.Cells(CLng(r), "I").value = toFl
            ws.Cells(CLng(r), "J").value = toCode
            ws.Range(ws.Cells(CLng(r), 24), ws.Cells(CLng(r), 35)).ClearContents
            parts = Split(toCode, "-")
            partial = ""
            For k = 0 To IIf(UBound(parts) > 5, 5, UBound(parts))
                If k = 0 Then partial = parts(0) Else partial = partial & "-" & parts(k)
                ws.Cells(CLng(r), 24 + k).value = partial
                dr = Application.Match(partial, wsLoc.Columns("O"), 0)
                If Not IsError(dr) Then ws.Cells(CLng(r), 30 + k).value = Trim$(wsLoc.Cells(CLng(dr), "B").value & " " & wsLoc.Cells(CLng(dr), "C").value)
            Next k
        Case "DISPOSE"
            ws.Cells(CLng(r), "AO").value = "Disposed"
        Case Else
            LogLine "Change", etag, "SKIPPED", "Unknown change type " & typ
            nSkip = nSkip + 1: GoTo NextRow
        End Select

        ws.Cells(CLng(r), "Q").value = Cell(v, 12)                         ' ChgBy
        ws.Cells(CLng(r), "R").value = ParseDmy(Cell(v, 4))                ' ChgOn
        ws.Cells(CLng(r), "R").NumberFormat = "dd.mm.yyyy"
        AppendHistory wsH, v
        LogLine "Change", etag, "APPLIED", typ & IIf(typ = "TRANSFER", " " & Cell(v, 6) & " -> " & toCode, " (" & Cell(v, 9) & ")")
        nOk = nOk + 1
NextRow:
    Next i
End Sub

Private Function HistorySheet() As Worksheet
    On Error Resume Next
    Set HistorySheet = ThisWorkbook.Sheets("AssetHistory")
    On Error GoTo 0
    If HistorySheet Is Nothing Then
        Set HistorySheet = ThisWorkbook.Sheets.Add(After:=ThisWorkbook.Sheets(ThisWorkbook.Sheets.Count))
        HistorySheet.Name = "AssetHistory"
        HistorySheet.Range("A1:N1").value = Array("Imported", "ChangeId", "Type", "EquipTagNo", "Date", "FromFuncLoc", "FromCode", _
            "ToFuncLoc", "ToCode", "Reason", "Reference", "Remarks", "User", "Recorded")
        HistorySheet.Range("A1:N1").Font.Bold = True
    End If
End Function

Private Sub AppendHistory(wsH As Worksheet, v As Variant)
    Dim r As Long, j As Long
    r = wsH.Cells(wsH.Rows.Count, "A").End(xlUp).Row + 1
    wsH.Cells(r, 1).value = Now
    For j = 1 To 13
        wsH.Cells(r, j + 1).value = Cell(v, j)
    Next j
    wsH.Cells(r, 5).value = ParseDmy(Cell(v, 4)): wsH.Cells(r, 5).NumberFormat = "dd.mm.yyyy"
End Sub

'===========================================================
'  EXPORT MASTER (same shape as the app's bundled seed.json)
'===========================================================
Public Sub ExportMasterForApp()

    Dim savePath As Variant
    Dim parts As Collection
    Dim wsC As Worksheet

    savePath = Application.GetSaveAsFilename( _
        InitialFileName:="AssetApp_master_" & Format$(Now, "yyyymmdd_hhnn") & ".json", _
        FileFilter:="JSON (*.json),*.json", Title:="Save master data for the app")
    If VarType(savePath) = vbBoolean Then Exit Sub

    On Error GoTo ErrHandler
    Application.ScreenUpdating = False
    Set wsC = ThisWorkbook.Sheets("Class&Units")
    Set parts = New Collection

    parts.Add "{""version"":" & JStr(Format$(Now, "yyyymmddhhnnss"))

    ' users: Admin J:L
    parts.Add ",""users"":" & ObjectsJson(ThisWorkbook.Sheets("Admin"), "J", Array("name", "id", "password", "role"), Array(0, 1, 2, 3), False)
    ' facilities: F-Facility A:B
    parts.Add ",""facilities"":" & ObjectsJson(ThisWorkbook.Sheets("F-Facility"), "A", Array("code", "name"), Array(0, 1), False)
    ' location classes: Class&Units B (key), C, D, E, A, G  -> offsets from B
    parts.Add ",""locClasses"":" & ObjectsJson(wsC, "B", Array("name", "cls", "locCode", "secondCode", "a", "g"), Array(0, 1, 2, 3, -1, 5), True)
    ' asset types: Class&Units U (key), V, W, X, Y
    parts.Add ",""assetTypes"":" & ObjectsJson(wsC, "U", Array("name", "system", "systemCode", "category", "categoryCode"), Array(0, 1, 2, 3, 4), True)

    parts.Add ",""units"":" & UniqueJson(wsC, "O")
    parts.Add ",""manufacturers"":" & UniqueJson(wsC, "AI")
    parts.Add ",""models"":" & UniqueJson(wsC, "AJ")
    parts.Add ",""receivedFrom"":" & UniqueJson(wsC, "S")

    parts.Add ",""locations"":" & RowsJson(ThisWorkbook.Sheets("Location"), LOC_COLS)
    parts.Add ",""assets"":" & RowsJson(ThisWorkbook.Sheets("Asset"), ASSET_COLS)
    parts.Add "}"

    WriteUtf8 CStr(savePath), JoinCollection(parts)
    Application.ScreenUpdating = True
    MsgBox "Master data saved:" & vbCrLf & savePath & vbCrLf & vbCrLf & _
           "Copy it to the phone (OneDrive / email) and use Sync -> Import master data.", vbInformation
    Exit Sub

ErrHandler:
    Application.ScreenUpdating = True
    MsgBox "Export error:" & vbCrLf & Err.Number & " - " & Err.Description, vbCritical
End Sub

' Array of objects keyed on keyCol (first occurrence wins, blanks skipped).
' offsets are relative to keyCol; dedupe=True mirrors "first match" lookups.
Private Function ObjectsJson(ws As Worksheet, keyCol As String, names As Variant, offsets As Variant, dedupe As Boolean) As String
    Dim lastRow As Long, i As Long, k As Long, c0 As Long
    Dim out() As String, n As Long, item As String, key As String
    Dim seen As Object
    Set seen = CreateObject("Scripting.Dictionary"): seen.CompareMode = vbTextCompare
    c0 = ws.Range(keyCol & "1").Column
    lastRow = ws.Cells(ws.Rows.Count, keyCol).End(xlUp).Row
    If lastRow < 2 Then ObjectsJson = "[]": Exit Function
    ReDim out(1 To lastRow)
    For i = 2 To lastRow
        key = CellText(ws.Cells(i, c0).value)
        If key <> "" Then
            If Not (dedupe And seen.Exists(key)) Then
                seen(key) = True
                item = "{"
                For k = LBound(names) To UBound(names)
                    If k > LBound(names) Then item = item & ","
                    item = item & JStr(CStr(names(k))) & ":" & JStr(CellText(ws.Cells(i, c0 + offsets(k)).value))
                Next k
                n = n + 1: out(n) = item & "}"
            End If
        End If
    Next i
    ObjectsJson = JoinArray(out, n)
End Function

Private Function UniqueJson(ws As Worksheet, col As String) As String
    Dim lastRow As Long, i As Long, n As Long, t As String
    Dim data As Variant, out() As String
    Dim seen As Object
    Set seen = CreateObject("Scripting.Dictionary"): seen.CompareMode = vbTextCompare
    lastRow = ws.Cells(ws.Rows.Count, col).End(xlUp).Row
    If lastRow < 2 Then UniqueJson = "[]": Exit Function
    data = ws.Range(col & "1:" & col & lastRow).value
    ReDim out(1 To lastRow)
    For i = 2 To lastRow
        t = CellText(data(i, 1))
        If t <> "" Then
            If Not seen.Exists(t) Then seen(t) = True: n = n + 1: out(n) = JStr(t)
        End If
    Next i
    UniqueJson = JoinArray(out, n)
End Function

Private Function RowsJson(ws As Worksheet, nCols As Long) As String
    Dim lastRow As Long, i As Long, j As Long, n As Long
    Dim data As Variant, out() As String, cells() As String
    lastRow = ws.Cells(ws.Rows.Count, "A").End(xlUp).Row
    If lastRow < 2 Then RowsJson = "[]": Exit Function
    data = ws.Range(ws.Cells(2, 1), ws.Cells(lastRow, nCols)).value
    ReDim out(1 To UBound(data))
    ReDim cells(1 To nCols)
    For i = 1 To UBound(data)
        If CellText(data(i, 1)) <> "" Then
            For j = 1 To nCols
                cells(j) = JStr(CellText(data(i, j)))
            Next j
            n = n + 1: out(n) = "[" & Join(cells, ",") & "]"
        End If
    Next i
    RowsJson = JoinArray(out, n)
End Function

'===========================================================
'  HELPERS
'===========================================================

' Cell value -> text the app expects (dates dd.mm.yyyy, "." decimals, no errors)
Private Function CellText(ByVal v As Variant) As String
    If IsError(v) Or IsEmpty(v) Or IsNull(v) Then CellText = "": Exit Function
    Select Case VarType(v)
        Case vbDate
            CellText = Format$(v, "dd\.mm\.yyyy")
        Case vbDouble, vbSingle, vbCurrency, vbDecimal, vbInteger, vbLong
            CellText = Trim$(Str$(v))                      ' "." decimal regardless of locale
            If Left$(CellText, 1) = "." Then CellText = "0" & CellText
            If Left$(CellText, 2) = "-." Then CellText = "-0" & Mid$(CellText, 2)
        Case Else
            CellText = Trim$(CStr(v))
    End Select
End Function

Private Function JStr(ByVal s As String) As String
    Dim i As Long, ch As String, code As Long, out As String
    s = Replace(s, "\", "\\")
    s = Replace(s, """", "\""")
    s = Replace(s, vbCrLf, "\n")
    s = Replace(s, vbCr, "\n")
    s = Replace(s, vbLf, "\n")
    s = Replace(s, vbTab, "\t")
    For i = 1 To Len(s)                       ' other control chars
        ch = Mid$(s, i, 1): code = AscW(ch)
        If code >= 0 And code < 32 Then out = out & "\u" & Right$("000" & Hex$(code), 4) Else out = out & ch
    Next i
    JStr = """" & out & """"
End Function

Private Function JoinArray(arr() As String, n As Long) As String
    If n = 0 Then JoinArray = "[]": Exit Function
    ReDim Preserve arr(1 To n)
    JoinArray = "[" & Join(arr, ",") & "]"
End Function

Private Function JoinCollection(c As Collection) As String
    Dim a() As String, i As Long
    ReDim a(1 To c.Count)
    For i = 1 To c.Count: a(i) = c(i): Next i
    JoinCollection = Join(a, "")
End Function

Private Sub WriteUtf8(path As String, text As String)
    Dim st As Object, bin As Object
    Set st = CreateObject("ADODB.Stream")
    st.Type = 2: st.Charset = "utf-8": st.Open
    st.WriteText text
    ' strip the BOM ADODB adds
    st.Position = 3
    Set bin = CreateObject("ADODB.Stream")
    bin.Type = 1: bin.Open
    st.CopyTo bin
    bin.SaveToFile path, 2
    bin.Close: st.Close
End Sub

Private Function ReadUtf8(path As String) As String
    Dim st As Object
    Set st = CreateObject("ADODB.Stream")
    st.Type = 2: st.Charset = "utf-8": st.Open
    st.LoadFromFile path
    ReadUtf8 = st.ReadText
    st.Close
    If Left$(ReadUtf8, 1) = ChrW(&HFEFF) Then ReadUtf8 = Mid$(ReadUtf8, 2)
End Function

' RFC-4180 CSV -> Collection of 1-based String arrays
Private Function ReadCsv(path As String) As Collection
    Dim s As String, i As Long, n As Long, ch As String
    Dim inQ As Boolean, field As String
    Dim fields As Collection, csvRows As New Collection

    s = ReadUtf8(path)
    n = Len(s)
    Set fields = New Collection
    i = 1
    Do While i <= n
        ch = Mid$(s, i, 1)
        If inQ Then
            If ch = """" Then
                If i < n And Mid$(s, i + 1, 1) = """" Then
                    field = field & """": i = i + 1
                Else
                    inQ = False
                End If
            Else
                field = field & ch
            End If
        Else
            Select Case ch
                Case """": inQ = True
                Case ",": fields.Add field: field = ""
                Case vbCr                      ' ignore, row ends on LF
                Case vbLf
                    fields.Add field: field = ""
                    csvRows.Add ToArray(fields)
                    Set fields = New Collection
                Case Else: field = field & ch
            End Select
        End If
        i = i + 1
    Loop
    If field <> "" Or fields.Count > 0 Then fields.Add field: csvRows.Add ToArray(fields)
    Set ReadCsv = csvRows
End Function

Private Function ToArray(c As Collection) As Variant
    Dim a() As String, i As Long
    ReDim a(1 To IIf(c.Count = 0, 1, c.Count))
    For i = 1 To c.Count: a(i) = c(i): Next i
    ToArray = a
End Function

Private Function Cell(v As Variant, j As Long) As String
    If j <= UBound(v) Then Cell = v(j) Else Cell = ""
End Function

Private Function ParseDmy(ByVal s As String) As Variant
    Dim p() As String
    s = Trim$(s)
    p = Split(s, ".")
    If UBound(p) = 2 Then
        If IsNumeric(p(0)) And IsNumeric(p(1)) And IsNumeric(p(2)) Then
            ParseDmy = DateSerial(CInt(p(2)), CInt(p(1)), CInt(p(0)))
            Exit Function
        End If
    End If
    If s = "" Then ParseDmy = Date Else ParseDmy = s
End Function

Private Function ExistsInColumn(ws As Worksheet, col As String, ByVal txt As String) As Boolean
    If Trim$(txt) = "" Then Exit Function
    ExistsInColumn = Not IsError(Application.Match(txt, ws.Columns(col), 0))
End Function

Private Sub AddIfMissing(ws As Worksheet, col As String, ByVal txt As String)
    Dim r As Long
    txt = Trim$(txt)
    If txt = "" Then Exit Sub
    If ExistsInColumn(ws, col, txt) Then Exit Sub
    r = ws.Cells(ws.Rows.Count, col).End(xlUp).Row + 1
    ws.Cells(r, col).value = txt
End Sub

Private Sub UnzipTo(zipFile As String, destFolder As String)
    Dim sh As Object, src As Object, dst As Object
    Set sh = CreateObject("Shell.Application")
    Set src = sh.Namespace(CVar(zipFile))
    Set dst = sh.Namespace(CVar(Left$(destFolder, Len(destFolder) - 1)))
    If src Is Nothing Or dst Is Nothing Then Err.Raise vbObjectError + 1, , "Cannot open ZIP: " & zipFile
    dst.CopyHere src.Items, 4 + 16                     ' no progress UI, yes to all

    ' CopyHere is asynchronous: wait for top-level items, then for every photo.
    Dim t As Single, expectedPhotos As Long, srcPhotos As Object
    t = Timer
    Do While dst.Items.Count < src.Items.Count And Timer - t < 60
        DoEvents
    Loop
    Set srcPhotos = src.ParseName("photos")
    If Not srcPhotos Is Nothing Then
        expectedPhotos = srcPhotos.GetFolder.Items.Count
        Do While CountFiles(destFolder & "photos\") < expectedPhotos And Timer - t < 180
            DoEvents
        Loop
    End If
    Do While Dir(destFolder & "Asset.csv") = "" And Timer - t < 60
        DoEvents
    Loop
End Sub

Private Function CountFiles(folder As String) As Long
    Dim f As String
    If Dir(folder, vbDirectory) = "" Then Exit Function
    f = Dir(folder & "*.*")
    Do While f <> ""
        CountFiles = CountFiles + 1
        f = Dir()
    Loop
End Function

Private Sub StartLog(source As String)
    On Error Resume Next
    Set mLog = ThisWorkbook.Sheets("AppImportLog")
    On Error GoTo 0
    If mLog Is Nothing Then
        Set mLog = ThisWorkbook.Sheets.Add(After:=ThisWorkbook.Sheets(ThisWorkbook.Sheets.Count))
        mLog.Name = "AppImportLog"
        mLog.Range("A1:F1").value = Array("Imported", "Source", "Type", "Key", "Result", "Detail")
        mLog.Range("A1:F1").Font.Bold = True
    End If
    mLogRow = mLog.Cells(mLog.Rows.Count, "A").End(xlUp).Row + 1
    mLog.Cells(mLogRow, 1).value = Now
    mLog.Cells(mLogRow, 2).value = source
    mLogRow = mLogRow + 1
End Sub

Private Sub LogLine(kind As String, key As String, result As String, detail As String)
    mLog.Cells(mLogRow, 1).value = Now
    mLog.Cells(mLogRow, 3).value = kind
    mLog.Cells(mLogRow, 4).value = key
    mLog.Cells(mLogRow, 5).value = result
    mLog.Cells(mLogRow, 6).value = detail
    mLogRow = mLogRow + 1
End Sub
