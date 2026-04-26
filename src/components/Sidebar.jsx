import React, { useState, useRef } from 'react';
import { X, Save, Upload, Plus, Trash2, Edit2, Check, FilePlus } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';

const getRandomColor = () => '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');

const Sidebar = ({
  projects,
  currentProjectId,
  setCurrentProjectId,
  createNewProject,
  selectedCountries,
  masterCountryNames,
  toggleCountrySelection,
  clearSelection,
  addUnifiedNation,
  unifiedNations,
  removeUnifiedNation,
  updateUnifiedNation,
  importState,
  exportState,
  editingId,
  setEditingId
}) => {
  const [nationName, setNationName] = useState('');
  const [nationColor, setNationColor] = useState(getRandomColor());
  const fileInputRef = useRef(null);

  // Edit states
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');

  const handleUnify = () => {
    if (!nationName.trim() || selectedCountries.length === 0) return;
    
    addUnifiedNation({
      id: uuidv4(),
      name: nationName.trim(),
      color: nationColor,
      countries: [...selectedCountries]
    });
    
    setNationName('');
    setNationColor(getRandomColor());
    clearSelection();
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target.result);
        if (data) {
          importState(data);
        }
      } catch (err) {
        console.error("Failed to parse JSON file", err);
        alert("Invalid map file");
      }
    };
    reader.readAsText(file);
    e.target.value = null;
  };

  const startEditing = (nation) => {
    setEditingId(nation.id);
    setEditName(nation.name);
    setEditColor(nation.color);
  };

  const saveEditing = () => {
    if (editingId && editName.trim()) {
      updateUnifiedNation(editingId, editName.trim(), editColor);
      setEditingId(null);
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h1>LIFEstream Map Utility</h1>
        <p>2046 Alternate Reality Visualizer</p>
      </div>

      <div className="sidebar-content">
        <section>
          <div className="section-title">Workspace Version</div>
          <div className="form-group" style={{ marginBottom: '10px' }}>
            <select 
              value={currentProjectId}
              onChange={(e) => setCurrentProjectId(e.target.value)}
              style={{
                backgroundColor: '#0f172a',
                border: '1px solid var(--border-color)',
                color: 'white',
                padding: '8px',
                borderRadius: '4px',
                width: '100%',
                marginBottom: '10px'
              }}
            >
              {projects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name} ({new Date(p.createdAt).toLocaleDateString()})
                </option>
              ))}
            </select>
          </div>
          
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={createNewProject} style={{ flex: '1 1 100%' }}>
              <FilePlus size={16} /> New Version
            </button>
            <button className="btn btn-secondary" onClick={exportState} style={{ flex: 1 }}>
              <Save size={16} /> Save JSON
            </button>
            <button 
              className="btn btn-secondary" 
              onClick={() => fileInputRef.current.click()}
              style={{ flex: 1 }}
            >
              <Upload size={16} /> Load JSON
            </button>
            <input 
              type="file" 
              ref={fileInputRef} 
              style={{ display: 'none' }} 
              accept=".json"
              onChange={handleFileChange}
            />
          </div>
        </section>

        {!editingId && (
          <section>
            <div className="section-title">
              Current Selection ({selectedCountries.length})
            </div>
            
            {selectedCountries.length === 0 ? (
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                Click on countries on the map to select them.
              </p>
            ) : (
              <>
                <div className="selected-countries" style={{ marginBottom: '15px' }}>
                  {selectedCountries.map(id => (
                    <div key={id} className="country-chip">
                      {masterCountryNames[id] || id}
                      <button className="remove-btn" onClick={() => toggleCountrySelection(id, masterCountryNames[id])}>
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="form-group">
                  <label>Nation Name</label>
                  <input 
                    type="text" 
                    value={nationName} 
                    onChange={e => setNationName(e.target.value)} 
                    placeholder="e.g., United Americas"
                  />
                </div>
                <div className="form-group">
                  <label>Map Color</label>
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <input 
                      type="color" 
                      value={nationColor} 
                      onChange={e => setNationColor(e.target.value)} 
                      style={{ flex: 1 }}
                    />
                    <button 
                      className="btn btn-secondary" 
                      style={{ width: 'auto', padding: '8px' }}
                      onClick={() => setNationColor(getRandomColor())}
                      title="Randomize Color"
                    >
                      🎲
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button 
                    className="btn" 
                    onClick={handleUnify}
                    disabled={!nationName.trim()}
                  >
                    <Plus size={16} /> Unify Selection
                  </button>
                  <button 
                    className="btn btn-secondary" 
                    onClick={clearSelection}
                  >
                    <X size={16} /> Clear
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {editingId && (
          <section>
            <div className="section-title">
              Editing Mode: {editName}
            </div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '15px' }}>
              Click countries on the map to add or remove them from this group.
            </p>
          </section>
        )}

        <section style={{ flex: 1 }}>
          <div className="section-title">
            Unified Nations ({unifiedNations.length})
          </div>
          
          <div className="unified-nations-list">
            {unifiedNations.map(nation => {
              const isEditingThis = editingId === nation.id;
              return (
                <div key={nation.id} className="unified-nation-card" style={{ borderColor: isEditingThis ? nation.color : 'var(--border-color)', borderWidth: isEditingThis ? '2px' : '1px' }}>
                  {isEditingThis ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <input 
                        type="text" 
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        style={{ background: '#0f172a', border: '1px solid var(--border-color)', color: 'white', padding: '5px', borderRadius: '4px' }}
                      />
                      <div style={{ display: 'flex', gap: '10px' }}>
                        <input 
                          type="color" 
                          value={editColor}
                          onChange={e => setEditColor(e.target.value)}
                          style={{ height: '30px', padding: '0', border: 'none', flex: 1 }}
                        />
                        <button className="btn btn-secondary" style={{ padding: '5px', flex: 1 }} onClick={saveEditing}>
                          <Check size={16} /> Save
                        </button>
                      </div>
                      
                      <div className="selected-countries" style={{ marginTop: '10px' }}>
                        {nation.countries.map(id => (
                          <div key={id} className="country-chip">
                            {masterCountryNames[id] || (nation.countryNames && nation.countryNames[id]) || id}
                            <button className="remove-btn" onClick={() => toggleCountrySelection(id, masterCountryNames[id] || (nation.countryNames && nation.countryNames[id]))}>
                              <X size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="unified-nation-header">
                        <div className="unified-nation-title">
                          <span 
                            className="color-swatch" 
                            style={{ backgroundColor: nation.color }}
                          ></span>
                          {nation.name}
                        </div>
                        <div style={{ display: 'flex', gap: '5px' }}>
                          <button 
                            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
                            onClick={() => startEditing(nation)}
                            title="Edit Unification"
                            disabled={editingId !== null && editingId !== nation.id}
                          >
                            <Edit2 size={16} />
                          </button>
                          <button 
                            style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}
                            onClick={() => removeUnifiedNation(nation.id)}
                            title="Remove Unification"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                      <div className="unified-nation-countries" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '8px' }}>
                        {nation.countries.map(id => masterCountryNames[id] || (nation.countryNames && nation.countryNames[id]) || id).join(', ')}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
            
            {unifiedNations.length === 0 && (
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                No unified nations created yet.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};

export default Sidebar;
